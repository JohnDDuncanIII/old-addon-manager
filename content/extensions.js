/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DownloadUtils.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/addons/AddonRepository.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "PluralForm",
                                  "resource://gre/modules/PluralForm.jsm");

XPCOMUtils.defineLazyGetter(this, "BrowserToolboxProcess", function () {
  return Cu.import("resource:///modules/devtools/ToolboxProcess.jsm", {}).
         BrowserToolboxProcess;
});
XPCOMUtils.defineLazyModuleGetter(this, "Experiments",
  "resource:///modules/experiments/Experiments.jsm");

const PREF_XPI_ENABLED = "xpinstall.enabled";
const PREF_MAXRESULTS = "extensions.getAddons.maxResults";
const PREF_GETADDONS_CACHE_ENABLED = "extensions.getAddons.cache.enabled";
const PREF_GETADDONS_CACHE_ID_ENABLED = "extensions.%ID%.getAddons.cache.enabled";
const PREF_UI_TYPE_HIDDEN = "extensions.ui.%TYPE%.hidden";
const PREF_UI_LASTCATEGORY = "extensions.ui.lastCategory";
const PREF_ADDON_DEBUGGING_ENABLED = "devtools.chrome.enabled";
const PREF_REMOTE_DEBUGGING_ENABLED = "devtools.debugger.remote-enabled";

const LOADING_MSG_DELAY = 100;

const UPDATES_RELEASENOTES_TRANSFORMFILE = "chrome://mozapps/content/extensions/updateinfo.xsl";

const XMLURI_PARSE_ERROR = "http://www.mozilla.org/newlayout/xml/parsererror.xml"

var gViewDefault = "addons://list/extension";

var gStrings = {};
XPCOMUtils.defineLazyServiceGetter(gStrings, "bundleSvc",
                                   "@mozilla.org/intl/stringbundle;1",
                                   "nsIStringBundleService");

XPCOMUtils.defineLazyGetter(gStrings, "brand", function brandLazyGetter() {
  return this.bundleSvc.createBundle("chrome://branding/locale/brand.properties");
});
XPCOMUtils.defineLazyGetter(gStrings, "ext", function extLazyGetter() {
  return this.bundleSvc.createBundle("chrome://mozapps/locale/extensions/extensions.properties");
});
XPCOMUtils.defineLazyGetter(gStrings, "oldext", function extLazyGetter() {
  return this.bundleSvc.createBundle("chrome://oam/locale/extensions.properties");
});
XPCOMUtils.defineLazyGetter(gStrings, "dl", function dlLazyGetter() {
  return this.bundleSvc.createBundle("chrome://mozapps/locale/downloads/downloads.properties");
});

XPCOMUtils.defineLazyGetter(gStrings, "brandShortName", function brandShortNameLazyGetter() {
  return this.brand.GetStringFromName("brandShortName");
});
XPCOMUtils.defineLazyGetter(gStrings, "appVersion", function appVersionLazyGetter() {
  return Services.appinfo.version;
});

document.addEventListener("load", initialize, true);
window.addEventListener("unload", shutdown, false);

var gPendingInitializations = 1;
this.__defineGetter__("gIsInitializing", function gIsInitializingGetter() gPendingInitializations > 0);

function initialize(event) {
  // XXXbz this listener gets _all_ load events for all nodes in the
  // document... but relies on not being called "too early".
  if (event.target instanceof XMLStylesheetProcessingInstruction) {
    return;
  }
  document.removeEventListener("load", initialize, true);

  let globalCommandSet = document.getElementById("globalCommandSet");
  globalCommandSet.addEventListener("command", function(event) {
    gViewController.doCommand(event.target.id);
  });

  let viewCommandSet = document.getElementById("viewCommandSet");
  viewCommandSet.addEventListener("commandupdate", function(event) {
    gViewController.updateCommands();
  });
  viewCommandSet.addEventListener("command", function(event) {
    gViewController.doCommand(event.target.id);
  });

  let addonPage = document.getElementById("addons-page");
  addonPage.addEventListener("dragenter", function(event) {
    gDragDrop.onDragOver(event);
  });
  addonPage.addEventListener("dragover", function(event) {
    gDragDrop.onDragOver(event);
  });
  addonPage.addEventListener("drop", function(event) {
    gDragDrop.onDrop(event);
  });

  gViewController.initialize();
  gCategories.initialize();
  gEventManager.initialize();
  gCommandBar.initialize();
  Services.obs.addObserver(sendEMPong, "EM-ping", false);
  Services.obs.notifyObservers(window, "EM-loaded", "");

  // If the initial view has already been selected (by a call to loadView from
  // the above notifications) then bail out now
  if (gViewController.initialViewSelected)
    return;

  // If there is a history state to restore then use that
  if (window.history.state) {
    gViewController.updateState(window.history.state);
    return;
  }

  // Default to the last selected category
  var view = gCategories.node.value;

  // Allow passing in a view through the window arguments
  if ("arguments" in window && window.arguments.length > 0 &&
      window.arguments[0] !== null && "view" in window.arguments[0]) {
    view = window.arguments[0].view;
  }

  gViewController.loadInitialView(view);

  Services.prefs.addObserver(PREF_ADDON_DEBUGGING_ENABLED, debuggingPrefChanged, false);
  Services.prefs.addObserver(PREF_REMOTE_DEBUGGING_ENABLED, debuggingPrefChanged, false);
}

function notifyInitialized() {
  if (!gIsInitializing)
    return;

  gPendingInitializations--;
  if (!gIsInitializing) {
    var event = document.createEvent("Events");
    event.initEvent("Initialized", true, true);
    document.dispatchEvent(event);
  }
}

function shutdown() {
  gCategories.shutdown();
  gSearchView.shutdown();
  gEventManager.shutdown();
  gViewController.shutdown();
  Services.obs.removeObserver(sendEMPong, "EM-ping");
  Services.prefs.removeObserver(PREF_ADDON_DEBUGGING_ENABLED, debuggingPrefChanged);
  Services.prefs.removeObserver(PREF_REMOTE_DEBUGGING_ENABLED, debuggingPrefChanged);
}

function sendEMPong(aSubject, aTopic, aData) {
  Services.obs.notifyObservers(window, "EM-pong", "");
}

// Used by external callers to load a specific view into the manager
function loadView(aViewId) {
  if (!gViewController.initialViewSelected) {
    // The caller opened the window and immediately loaded the view so it
    // should be the initial history entry

    gViewController.loadInitialView(aViewId);
  } else {
    gViewController.loadView(aViewId);
  }
}

function getExperimentEndDate(aAddon) {
  if (!("@mozilla.org/browser/experiments-service;1" in Cc)) {
    return 0;
  }

  if (!aAddon.isActive) {
    return aAddon.endDate;
  }

  let experiment = Experiments.instance().getActiveExperiment();
  if (!experiment) {
    return 0;
  }

  return experiment.endDate;
}

/**
 * Obtain the main DOMWindow for the current context.
 */
function getMainWindow() {
  return window.QueryInterface(Ci.nsIInterfaceRequestor)
               .getInterface(Ci.nsIWebNavigation)
               .QueryInterface(Ci.nsIDocShellTreeItem)
               .rootTreeItem
               .QueryInterface(Ci.nsIInterfaceRequestor)
               .getInterface(Ci.nsIDOMWindow);
}

function getBrowserElement() {
  return window.QueryInterface(Ci.nsIInterfaceRequestor)
               .getInterface(Ci.nsIDocShell)
               .chromeEventHandler;
}

/**
 * Obtain the DOMWindow that can open a preferences pane.
 *
 * This is essentially "get the browser chrome window" with the added check
 * that the supposed browser chrome window is capable of opening a preferences
 * pane.
 *
 * This may return null if we can't find the browser chrome window.
 */
function getMainWindowWithPreferencesPane() {
  let mainWindow = getMainWindow();
  if (mainWindow && "openAdvancedPreferences" in mainWindow) {
    return mainWindow;
  } else {
    return null;
  }
}

var gEventManager = {
  _listeners: {},
  _installListeners: [],

  initialize: function gEM_initialize() {
    var self = this;
    const ADDON_EVENTS = ["onEnabling", "onEnabled", "onDisabling",
                          "onDisabled", "onUninstalling", "onUninstalled",
                          "onInstalled", "onOperationCancelled",
                          "onUpdateAvailable", "onUpdateFinished",
                          "onCompatibilityUpdateAvailable",
                          "onPropertyChanged"];
    for (let evt of ADDON_EVENTS) {
      let event = evt;
      self[event] = function initialize_delegateAddonEvent(...aArgs) {
        self.delegateAddonEvent(event, aArgs);
      };
    }

    const INSTALL_EVENTS = ["onNewInstall", "onDownloadStarted",
                            "onDownloadEnded", "onDownloadFailed",
                            "onDownloadProgress", "onDownloadCancelled",
                            "onInstallStarted", "onInstallEnded",
                            "onInstallFailed", "onInstallCancelled",
                            "onExternalInstall"];
    for (let evt of INSTALL_EVENTS) {
      let event = evt;
      self[event] = function initialize_delegateInstallEvent(...aArgs) {
        self.delegateInstallEvent(event, aArgs);
      };
    }

    AddonManager.addManagerListener(this);
    AddonManager.addInstallListener(this);
    AddonManager.addAddonListener(this);

    this.refreshGlobalWarning();
    this.refreshAutoUpdateDefault();

    var contextMenu = document.getElementById("addonitem-popup");
    contextMenu.addEventListener("popupshowing", function contextMenu_onPopupshowing() {
      var addon = gViewController.currentViewObj.getSelectedAddon();
      contextMenu.setAttribute("addontype", addon.type);

      var menuSep = document.getElementById("addonitem-menuseparator");
      var countMenuItemsBeforeSep = 0;
      for (let child of contextMenu.children) {
        if (child == menuSep) {
          break;
        }
        if (child.nodeName == "menuitem" &&
          gViewController.isCommandEnabled(child.command)) {
            countMenuItemsBeforeSep++;
        }
      }

      // Hide the separator if there are no visible menu items before it
      menuSep.hidden = (countMenuItemsBeforeSep == 0);

      var autoUpdate = document.getElementById("menu_updateItem");
      var autoUpdateSep = document.getElementById("menu_updateSeparator");

      autoUpdate.hidden = !("applyBackgroundUpdates" in addon);
      autoUpdateSep.hidden = !("applyBackgroundUpdates" in addon);

      gViewController.updateCommand("cmd_updateItemDefault", addon);
      gViewController.updateCommand("cmd_updateItemAuto", addon);
      gViewController.updateCommand("cmd_updateItemManual", addon);
    }, false);
  },

  shutdown: function gEM_shutdown() {
    AddonManager.removeManagerListener(this);
    AddonManager.removeInstallListener(this);
    AddonManager.removeAddonListener(this);
  },

  registerAddonListener: function gEM_registerAddonListener(aListener, aAddonId) {
    if (!(aAddonId in this._listeners))
      this._listeners[aAddonId] = [];
    else if (this._listeners[aAddonId].indexOf(aListener) != -1)
      return;
    this._listeners[aAddonId].push(aListener);
  },

  unregisterAddonListener: function gEM_unregisterAddonListener(aListener, aAddonId) {
    if (!(aAddonId in this._listeners))
      return;
    var index = this._listeners[aAddonId].indexOf(aListener);
    if (index == -1)
      return;
    this._listeners[aAddonId].splice(index, 1);
  },

  registerInstallListener: function gEM_registerInstallListener(aListener) {
    if (this._installListeners.indexOf(aListener) != -1)
      return;
    this._installListeners.push(aListener);
  },

  unregisterInstallListener: function gEM_unregisterInstallListener(aListener) {
    var i = this._installListeners.indexOf(aListener);
    if (i == -1)
      return;
    this._installListeners.splice(i, 1);
  },

  delegateAddonEvent: function gEM_delegateAddonEvent(aEvent, aParams) {
    var addon = aParams.shift();
    if (!(addon.id in this._listeners))
      return;

    var listeners = this._listeners[addon.id];
    for (let listener of listeners) {
      if (!(aEvent in listener))
        continue;
      try {
        listener[aEvent].apply(listener, aParams);
      } catch(e) {
        // this shouldn't be fatal
        Cu.reportError(e);
      }
    }
  },

  delegateInstallEvent: function gEM_delegateInstallEvent(aEvent, aParams) {
    var existingAddon = aEvent == "onExternalInstall" ? aParams[1] : aParams[0].existingAddon;
    // If the install is an update then send the event to all listeners
    // registered for the existing add-on
    if (existingAddon)
      this.delegateAddonEvent(aEvent, [existingAddon].concat(aParams));

    for (let listener of this._installListeners) {
      if (!(aEvent in listener))
        continue;
      try {
        listener[aEvent].apply(listener, aParams);
      } catch(e) {
        // this shouldn't be fatal
        Cu.reportError(e);
      }
    }
  },

  refreshGlobalWarning: function gEM_refreshGlobalWarning() {
    var page = document.getElementById("addons-page");

    if (Services.appinfo.inSafeMode) {
      page.setAttribute("warning", "safemode");
      return;
    }

    if (AddonManager.checkUpdateSecurityDefault &&
        !AddonManager.checkUpdateSecurity) {
      page.setAttribute("warning", "updatesecurity");
      return;
    }

    if (!AddonManager.checkCompatibility) {
      page.setAttribute("warning", "checkcompatibility");
      return;
    }

    page.removeAttribute("warning");
  },

  refreshAutoUpdateDefault: function gEM_refreshAutoUpdateDefault() {
    var updateEnabled = AddonManager.updateEnabled;
    var autoUpdateDefault = AddonManager.autoUpdateDefault;

    // The checkbox needs to reflect that both prefs need to be true
    // for updates to be checked for and applied automatically
    document.getElementById("utils-autoUpdateDefault")
            .setAttribute("checked", updateEnabled && autoUpdateDefault);

    document.getElementById("utils-resetAddonUpdatesToAutomatic").hidden = !autoUpdateDefault;
    document.getElementById("utils-resetAddonUpdatesToManual").hidden = autoUpdateDefault;
  },

  onCompatibilityModeChanged: function gEM_onCompatibilityModeChanged() {
    this.refreshGlobalWarning();
  },

  onCheckUpdateSecurityChanged: function gEM_onCheckUpdateSecurityChanged() {
    this.refreshGlobalWarning();
  },

  onUpdateModeChanged: function gEM_onUpdateModeChanged() {
    this.refreshAutoUpdateDefault();
  }
};


var gViewController = {
  viewPort: null,
  currentViewId: "",
  currentViewObj: null,
  currentViewRequest: 0,
  viewObjects: {},
  viewChangeCallback: null,
  initialViewSelected: false,

  initialize: function gVC_initialize() {
    this.viewPort = document.getElementById("view-port");

    this.viewObjects["search"] = gSearchView;
    this.viewObjects["list"] = gListView;
    this.viewObjects["updates"] = gUpdatesView;

    for each (let view in this.viewObjects)
      view.initialize();

    window.controllers.appendController(this);
  },

  shutdown: function gVC_shutdown() {
    if (this.currentViewObj)
      this.currentViewObj.hide();
    this.currentViewRequest = 0;

    for each(let view in this.viewObjects) {
      if ("shutdown" in view) {
        try {
          view.shutdown();
        } catch(e) {
          // this shouldn't be fatal
          Cu.reportError(e);
        }
      }
    }

    window.controllers.removeController(this);
  },

  updateState: function gVC_updateState(state) {
    try {
      this.loadViewInternal(state.view, state.previousView, state);
    }
    catch (e) {
      // The attempt to load the view failed, try moving further along history
      gViewController.replaceView(gViewDefault);
    }
  },

  parseViewId: function gVC_parseViewId(aViewId) {
    var matchRegex = /^addons:\/\/([^\/]+)\/(.*)$/;
    var [,viewType, viewParam] = aViewId.match(matchRegex) || [];
    return {type: viewType, param: decodeURIComponent(viewParam)};
  },

  get isLoading() {
    return !this.currentViewObj || this.currentViewObj.node.hasAttribute("loading");
  },

  loadView: function gVC_loadView(aViewId) {
    var isRefresh = false;
    if (aViewId == this.currentViewId) {
      if (this.isLoading)
        return;
      if (!("refresh" in this.currentViewObj))
        return;
      if (!this.currentViewObj.canRefresh())
        return;
      isRefresh = true;
    }

    var state = {
      view: aViewId,
      previousView: this.currentViewId
    };
    this.loadViewInternal(aViewId, this.currentViewId, state);
  },

  // Replaces the existing view with a new one, rewriting the current history
  // entry to match.
  replaceView: function gVC_replaceView(aViewId) {
    if (aViewId == this.currentViewId)
      return;

    var state = {
      view: aViewId,
      previousView: null
    };
    this.loadViewInternal(aViewId, null, state);
  },

  loadInitialView: function gVC_loadInitialView(aViewId) {
    var state = {
      view: aViewId,
      previousView: null
    };

    this.loadViewInternal(aViewId, null, state);
    this.initialViewSelected = true;
    notifyInitialized();
  },

  loadViewInternal: function gVC_loadViewInternal(aViewId, aPreviousView, aState) {
    var view = this.parseViewId(aViewId);

    if (!view.type || !(view.type in this.viewObjects))
      throw Components.Exception("Invalid view: " + view.type);

    var viewObj = this.viewObjects[view.type];
    if (!viewObj.node)
      throw Components.Exception("Root node doesn't exist for '" + view.type + "' view");

    if (this.currentViewObj && aViewId != aPreviousView) {
      try {
        let canHide = this.currentViewObj.hide();
        if (canHide === false)
          return;
        this.viewPort.selectedPanel.removeAttribute("loading");
      } catch (e) {
        // this shouldn't be fatal
        Cu.reportError(e);
      }
    }

    gCategories.select(aViewId, aPreviousView);

    this.currentViewId = aViewId;
    this.currentViewObj = viewObj;

    this.viewPort.selectedPanel = this.currentViewObj.node;
    this.viewPort.selectedPanel.setAttribute("loading", "true");
    this.currentViewObj.node.focus();

    if (aViewId == aPreviousView)
      this.currentViewObj.refresh(view.param, ++this.currentViewRequest, aState);
    else
      this.currentViewObj.show(view.param, ++this.currentViewRequest, aState);
    gCommandBar.onViewChanged(view.type, view.param);
  },

  notifyViewChanged: function gVC_notifyViewChanged() {
    this.viewPort.selectedPanel.removeAttribute("loading");

    if (this.viewChangeCallback) {
      this.viewChangeCallback();
      this.viewChangeCallback = null;
    }

    var event = document.createEvent("Events");
    event.initEvent("ViewChanged", true, true);
    this.currentViewObj.node.dispatchEvent(event);
  },

  commands: {
    cmd_restartApp: {
      isEnabled: function cmd_restartApp_isEnabled() true,
      doCommand: function cmd_restartApp_doCommand() {
        let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"].
                         createInstance(Ci.nsISupportsPRBool);
        Services.obs.notifyObservers(cancelQuit, "quit-application-requested",
                                     "restart");
        if (cancelQuit.data)
          return; // somebody canceled our quit request

        let appStartup = Cc["@mozilla.org/toolkit/app-startup;1"].
                         getService(Ci.nsIAppStartup);
        appStartup.quit(Ci.nsIAppStartup.eAttemptQuit |  Ci.nsIAppStartup.eRestart);
      }
    },

    cmd_enableCheckCompatibility: {
      isEnabled: function cmd_enableCheckCompatibility_isEnabled() true,
      doCommand: function cmd_enableCheckCompatibility_doCommand() {
        AddonManager.checkCompatibility = true;
      }
    },

    cmd_enableUpdateSecurity: {
      isEnabled: function cmd_enableUpdateSecurity_isEnabled() true,
      doCommand: function cmd_enableUpdateSecurity_doCommand() {
        AddonManager.checkUpdateSecurity = true;
      }
    },

    cmd_pluginCheck: {
      isEnabled: function cmd_pluginCheck_isEnabled() true,
      doCommand: function cmd_pluginCheck_doCommand() {
        openURL(Services.urlFormatter.formatURLPref("plugins.update.url"));
      }
    },

    cmd_toggleAutoUpdateDefault: {
      isEnabled: function cmd_toggleAutoUpdateDefault_isEnabled() true,
      doCommand: function cmd_toggleAutoUpdateDefault_doCommand() {
        if (!AddonManager.updateEnabled || !AddonManager.autoUpdateDefault) {
          // One or both of the prefs is false, i.e. the checkbox is not checked.
          // Now toggle both to true. If the user wants us to auto-update
          // add-ons, we also need to auto-check for updates.
          AddonManager.updateEnabled = true;
          AddonManager.autoUpdateDefault = true;
        } else {
          // Both prefs are true, i.e. the checkbox is checked.
          // Toggle the auto pref to false, but don't touch the enabled check.
          AddonManager.autoUpdateDefault = false;
        }
      }
    },

    cmd_resetAddonAutoUpdate: {
      isEnabled: function cmd_resetAddonAutoUpdate_isEnabled() true,
      doCommand: function cmd_resetAddonAutoUpdate_doCommand() {
        AddonManager.getAllAddons(function cmd_resetAddonAutoUpdate_getAllAddons(aAddonList) {
          for (let addon of aAddonList) {
            if ("applyBackgroundUpdates" in addon)
              addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DEFAULT;
          }
        });
      }
    },

    cmd_goToUpdates: {
      isEnabled: function cmd_goToUpdates_isEnabled() true,
      doCommand: function cmd_goToUpdates_doCommand() {
        gViewController.loadView("addons://updates/");
      }
    },

    cmd_findAllUpdates: {
      inProgress: false,
      isEnabled: function cmd_findAllUpdates_isEnabled() !this.inProgress,
      doCommand: function cmd_findAllUpdates_doCommand() {
        this.inProgress = true;
        gViewController.updateCommand("cmd_findAllUpdates");

        var pendingChecks = 0;
        var numUpdated = 0;
        var numManualUpdates = 0;
        var restartNeeded = false;
        var self = this;

        function updateStatus() {
          if (pendingChecks > 0)
            return;

          self.inProgress = false;
          gViewController.updateCommand("cmd_findAllUpdates");
          gUpdatesView.maybeRefresh();
        }

        var updateInstallListener = {
          onDownloadFailed: function cmd_findAllUpdates_downloadFailed() {
            pendingChecks--;
            updateStatus();
          },
          onInstallFailed: function cmd_findAllUpdates_installFailed() {
            pendingChecks--;
            updateStatus();
          },
          onInstallEnded: function cmd_findAllUpdates_installEnded(aInstall, aAddon) {
            pendingChecks--;
            numUpdated++;
            if (isPending(aInstall.existingAddon, "upgrade"))
              restartNeeded = true;
            updateStatus();
          }
        };

        var updateCheckListener = {
          onUpdateAvailable: function cmd_findAllUpdates_updateAvailable(aAddon, aInstall) {
            gEventManager.delegateAddonEvent("onUpdateAvailable",
                                             [aAddon, aInstall]);
            if (AddonManager.shouldAutoUpdate(aAddon)) {
              aInstall.addListener(updateInstallListener);
              aInstall.install();
            } else {
              pendingChecks--;
              numManualUpdates++;
              updateStatus();
            }
          },
          onNoUpdateAvailable: function cmd_findAllUpdates_noUpdateAvailable(aAddon) {
            pendingChecks--;
            updateStatus();
          },
          onUpdateFinished: function cmd_findAllUpdates_updateFinished(aAddon, aError) {
            gEventManager.delegateAddonEvent("onUpdateFinished",
                                             [aAddon, aError]);
          }
        };

        AddonManager.getAddonsByTypes(null, function cmd_findAllUpdates_getAddonsByTypes(aAddonList) {
          for (let addon of aAddonList) {
            if (addon.permissions & AddonManager.PERM_CAN_UPGRADE) {
              pendingChecks++;
              addon.findUpdates(updateCheckListener,
                                AddonManager.UPDATE_WHEN_USER_REQUESTED);
            }
          }

          if (pendingChecks == 0)
            updateStatus();
        });
      }
    },

    cmd_findItemUpdates: {
      isEnabled: function cmd_findItemUpdates_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        return hasPermission(aAddon, "upgrade");
      },
      doCommand: function cmd_findItemUpdates_doCommand(aAddon) {
        var listener = {
          onUpdateAvailable: function cmd_findItemUpdates_updateAvailable(aAddon, aInstall) {
            gEventManager.delegateAddonEvent("onUpdateAvailable",
                                             [aAddon, aInstall]);
            if (AddonManager.shouldAutoUpdate(aAddon))
              aInstall.install();
          },
          onNoUpdateAvailable: function cmd_findItemUpdates_noUpdateAvailable(aAddon) {
            gEventManager.delegateAddonEvent("onNoUpdateAvailable",
                                             [aAddon]);
          }
        };
        gEventManager.delegateAddonEvent("onCheckingUpdate", [aAddon]);
        aAddon.findUpdates(listener, AddonManager.UPDATE_WHEN_USER_REQUESTED);
      }
    },

    cmd_debugItem: {
      doCommand: function cmd_debugItem_doCommand(aAddon) {
        BrowserToolboxProcess.init({ addonID: aAddon.id });
      },

      isEnabled: function cmd_debugItem_isEnabled(aAddon) {
        let debuggerEnabled = Services.prefs.
                              getBoolPref(PREF_ADDON_DEBUGGING_ENABLED);
        let remoteEnabled = Services.prefs.
                            getBoolPref(PREF_REMOTE_DEBUGGING_ENABLED);
        return aAddon && aAddon.isDebuggable && debuggerEnabled && remoteEnabled;
      }
    },

    cmd_showItemPreferences: {
      isEnabled: function cmd_showItemPreferences_isEnabled(aAddon) {
        if (!aAddon ||
            (!aAddon.isActive && !aAddon.isGMPlugin) ||
            !aAddon.optionsURL) {
          return false;
        }
        return true;
      },
      doCommand: function cmd_showItemPreferences_doCommand(aAddon) {
        if (aAddon.optionsType == AddonManager.OPTIONS_TYPE_INLINE) {
		  openDialog("chrome://oam/content/inlinePrefDialog.xul",
		             "", "all", aAddon);
          return;
        }
        var optionsURL = aAddon.optionsURL;
        if (aAddon.optionsType == AddonManager.OPTIONS_TYPE_TAB &&
            openOptionsInTab(optionsURL)) {
          return;
        }
        var windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          var win = windows.getNext();
          if (win.closed) {
            continue;
          }
          if (win.document.documentURI == optionsURL) {
            win.focus();
            return;
          }
        }
        var features = "chrome,titlebar,toolbar,centerscreen";
        try {
          var instantApply = Services.prefs.getBoolPref("browser.preferences.instantApply");
          features += instantApply ? ",dialog=no" : ",modal";
        } catch (e) {
          features += ",modal";
        }
        openDialog(optionsURL, "", features);
      }
    },

    cmd_showItemAbout: {
      isEnabled: function cmd_showItemAbout_isEnabled(aAddon) {
        // XXXunf This may be applicable to install items too. See bug 561260
        return !!aAddon;
      },
      doCommand: function cmd_showItemAbout_doCommand(aAddon) {
        var aboutURL = aAddon.aboutURL;
        if (aboutURL)
          openDialog(aboutURL, "", "chrome,centerscreen,modal", aAddon);
        else
          openDialog("chrome://mozapps/content/extensions/about.xul",
                     "", "chrome,centerscreen,modal", aAddon);
      }
    },

    cmd_enableItem: {
      isEnabled: function cmd_enableItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        let addonType = AddonManager.addonTypes[aAddon.type];
        return (!(addonType.flags & AddonManager.TYPE_SUPPORTS_ASK_TO_ACTIVATE) &&
                hasPermission(aAddon, "enable"));
      },
      doCommand: function cmd_enableItem_doCommand(aAddon) {
        aAddon.userDisabled = false;
      },
      getTooltip: function cmd_enableItem_getTooltip(aAddon) {
        if (!aAddon)
          return "";
        if (aAddon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_ENABLE)
          return gStrings.ext.GetStringFromName("enableAddonRestartRequiredTooltip");
        return gStrings.ext.GetStringFromName("enableAddonTooltip");
      }
    },

    cmd_disableItem: {
      isEnabled: function cmd_disableItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        let addonType = AddonManager.addonTypes[aAddon.type];
        return (!(addonType.flags & AddonManager.TYPE_SUPPORTS_ASK_TO_ACTIVATE) &&
                hasPermission(aAddon, "disable"));
      },
      doCommand: function cmd_disableItem_doCommand(aAddon) {
        aAddon.userDisabled = true;
      },
      getTooltip: function cmd_disableItem_getTooltip(aAddon) {
        if (!aAddon)
          return "";
        if (aAddon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_DISABLE)
          return gStrings.ext.GetStringFromName("disableAddonRestartRequiredTooltip");
        return gStrings.ext.GetStringFromName("disableAddonTooltip");
      }
    },

    cmd_installItem: {
      isEnabled: function cmd_installItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        return aAddon.install && aAddon.install.state == AddonManager.STATE_AVAILABLE;
      },
      doCommand: function cmd_installItem_doCommand(aAddon) {
        function doInstall() {
          gViewController.currentViewObj.getListItemForID(aAddon.id)._installStatus.installRemote();
        }

        doInstall();
      }
    },

    cmd_purchaseItem: {
      isEnabled: function cmd_purchaseItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        return !!aAddon.purchaseURL;
      },
      doCommand: function cmd_purchaseItem_doCommand(aAddon) {
        openURL(aAddon.purchaseURL);
      }
    },

    cmd_uninstallItem: {
      isEnabled: function cmd_uninstallItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        return hasPermission(aAddon, "uninstall");
      },
      doCommand: function cmd_uninstallItem_doCommand(aAddon) {
        aAddon.uninstall();
      },
      getTooltip: function cmd_uninstallItem_getTooltip(aAddon) {
        if (!aAddon)
          return "";
        if (aAddon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_UNINSTALL)
          return gStrings.ext.GetStringFromName("uninstallAddonRestartRequiredTooltip");
        return gStrings.ext.GetStringFromName("uninstallAddonTooltip");
      }
    },

    cmd_cancelUninstallItem: {
      isEnabled: function cmd_cancelUninstallItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        return isPending(aAddon, "uninstall");
      },
      doCommand: function cmd_cancelUninstallItem_doCommand(aAddon) {
        aAddon.cancelUninstall();
      }
    },

    cmd_installFromFile: {
      isEnabled: function cmd_installFromFile_isEnabled() true,
      doCommand: function cmd_installFromFile_doCommand() {
        const nsIFilePicker = Ci.nsIFilePicker;
        var fp = Cc["@mozilla.org/filepicker;1"]
                   .createInstance(nsIFilePicker);
        fp.init(window,
                gStrings.ext.GetStringFromName("installFromFile.dialogTitle"),
                nsIFilePicker.modeOpenMultiple);
        try {
          fp.appendFilter(gStrings.ext.GetStringFromName("installFromFile.filterName"),
                          "*.xpi;*.jar");
          fp.appendFilters(nsIFilePicker.filterAll);
        } catch (e) { }

        if (fp.show() != nsIFilePicker.returnOK)
          return;

        var files = fp.files;
        var installs = [];

        function buildNextInstall() {
          if (!files.hasMoreElements()) {
            if (installs.length > 0) {
              // Display the normal install confirmation for the installs
              AddonManager.installAddonsFromWebpage("application/x-xpinstall",
                                                    getBrowserElement(), null, installs);
            }
            return;
          }

          var file = files.getNext();
          AddonManager.getInstallForFile(file, function cmd_installFromFile_getInstallForFile(aInstall) {
            installs.push(aInstall);
            buildNextInstall();
          });
        }

        buildNextInstall();
      }
    },

    cmd_cancelOperation: {
      isEnabled: function cmd_cancelOperation_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        return aAddon.pendingOperations != AddonManager.PENDING_NONE;
      },
      doCommand: function cmd_cancelOperation_doCommand(aAddon) {
        if (isPending(aAddon, "install")) {
          aAddon.install.cancel();
        } else if (isPending(aAddon, "upgrade")) {
          aAddon.pendingUpgrade.install.cancel();
        } else if (isPending(aAddon, "uninstall")) {
          aAddon.cancelUninstall();
        } else if (isPending(aAddon, "enable")) {
          aAddon.userDisabled = true;
        } else if (isPending(aAddon, "disable")) {
          aAddon.userDisabled = false;
        }
      }
    },

    cmd_contribute: {
      isEnabled: function cmd_contribute_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        return ("contributionURL" in aAddon && aAddon.contributionURL);
      },
      doCommand: function cmd_contribute_doCommand(aAddon) {
        openURL(aAddon.contributionURL);
      }
    },

    cmd_askToActivateItem: {
      isEnabled: function cmd_askToActivateItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        let addonType = AddonManager.addonTypes[aAddon.type];
        return ((addonType.flags & AddonManager.TYPE_SUPPORTS_ASK_TO_ACTIVATE) &&
                hasPermission(aAddon, "ask_to_activate"));
      },
      doCommand: function cmd_askToActivateItem_doCommand(aAddon) {
        aAddon.userDisabled = AddonManager.STATE_ASK_TO_ACTIVATE;
      }
    },

    cmd_alwaysActivateItem: {
      isEnabled: function cmd_alwaysActivateItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        let addonType = AddonManager.addonTypes[aAddon.type];
        return ((addonType.flags & AddonManager.TYPE_SUPPORTS_ASK_TO_ACTIVATE) &&
                hasPermission(aAddon, "enable"));
      },
      doCommand: function cmd_alwaysActivateItem_doCommand(aAddon) {
        aAddon.userDisabled = false;
      }
    },

    cmd_neverActivateItem: {
      isEnabled: function cmd_neverActivateItem_isEnabled(aAddon) {
        if (!aAddon)
          return false;
        let addonType = AddonManager.addonTypes[aAddon.type];
        return ((addonType.flags & AddonManager.TYPE_SUPPORTS_ASK_TO_ACTIVATE) &&
                hasPermission(aAddon, "disable"));
      },
      doCommand: function cmd_neverActivateItem_doCommand(aAddon) {
        aAddon.userDisabled = true;
      }
    },

    cmd_experimentsLearnMore: {
      isEnabled: function cmd_experimentsLearnMore_isEnabled() {
        let mainWindow = getMainWindow();
        return mainWindow && "switchToTabHavingURI" in mainWindow;
      },
      doCommand: function cmd_experimentsLearnMore_doCommand() {
        let url = Services.prefs.getCharPref("toolkit.telemetry.infoURL");
        openOptionsInTab(url);
      },
    },

    cmd_experimentsOpenTelemetryPreferences: {
      isEnabled: function cmd_experimentsOpenTelemetryPreferences_isEnabled() {
        return !!getMainWindowWithPreferencesPane();
      },
      doCommand: function cmd_experimentsOpenTelemetryPreferences_doCommand() {
        let mainWindow = getMainWindowWithPreferencesPane();
        mainWindow.openAdvancedPreferences("dataChoicesTab");
      },
    },

    cmd_browseAddons: {
      isEnabled: function cmd_browseAddons_isEnabled() {
        return true;
      },
      doCommand: function cmd_browseAddons_doCommand() {
        openURL(Services.urlFormatter.formatURLPref("extensions.oam.browseAddons"));
      },
    },

    cmd_updateItemDefault: {
      isEnabled: function cmd_updateItemDefault_isEnabled(aAddon) {
        return aAddon;
      },
      isChecked: function cmd_updateItemDefault_isChecked(aAddon) {
        return aAddon.applyBackgroundUpdates == AddonManager.AUTOUPDATE_DEFAULT;
      },
      doCommand: function cmd_updateItemDefault_doCommand(aAddon) {
        aAddon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DEFAULT;
      },
    },

    cmd_updateItemAuto: {
      isEnabled: function cmd_updateItemAuto_isEnabled(aAddon) {
        return aAddon;
      },
      isChecked: function cmd_updateItemAuto_isChecked(aAddon) {
        return aAddon.applyBackgroundUpdates == AddonManager.AUTOUPDATE_ENABLE;
      },
      doCommand: function cmd_updateItemAuto_doCommand(aAddon) {
        aAddon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_ENABLE;
      },
    },

    cmd_updateItemManual: {
      isEnabled: function cmd_updateItemManual_isEnabled(aAddon) {
        return aAddon;
      },
      isChecked: function cmd_updateItemManual_isChecked(aAddon) {
        return aAddon.applyBackgroundUpdates == AddonManager.AUTOUPDATE_DISABLE;
      },
      doCommand: function cmd_updateItemManual_doCommand(aAddon) {
        aAddon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DISABLE;
      },
    }
  },

  supportsCommand: function gVC_supportsCommand(aCommand) {
    return (aCommand in this.commands);
  },

  isCommandEnabled: function gVC_isCommandEnabled(aCommand) {
    if (!this.supportsCommand(aCommand))
      return false;
    var addon = this.currentViewObj.getSelectedAddon();
    return this.commands[aCommand].isEnabled(addon);
  },

  updateCommands: function gVC_updateCommands() {
    // wait until the view is initialized
    if (!this.currentViewObj)
      return;
    var addon = this.currentViewObj.getSelectedAddon();
    for (let commandId in this.commands)
      this.updateCommand(commandId, addon);
  },

  updateCommand: function gVC_updateCommand(aCommandId, aAddon) {
    if (typeof aAddon == "undefined")
      aAddon = this.currentViewObj.getSelectedAddon();
    var cmd = this.commands[aCommandId];
    var cmdElt = document.getElementById(aCommandId);
    cmdElt.setAttribute("disabled", !cmd.isEnabled(aAddon));

    if (aAddon && "isChecked" in cmd) {
      cmdElt.setAttribute("checked", cmd.isChecked(aAddon));
    }
    if ("getTooltip" in cmd) {
      let tooltip = cmd.getTooltip(aAddon);
      if (tooltip)
        cmdElt.setAttribute("tooltiptext", tooltip);
      else
        cmdElt.removeAttribute("tooltiptext");
    }
  },

  doCommand: function gVC_doCommand(aCommand, aAddon) {
    if (!this.supportsCommand(aCommand))
      return;
    var cmd = this.commands[aCommand];
    if (!aAddon)
      aAddon = this.currentViewObj.getSelectedAddon();
    if (!cmd.isEnabled(aAddon))
      return;
    cmd.doCommand(aAddon);
  },

  onEvent: function gVC_onEvent() {}
};

function hasInlineOptions(aAddon) {
  return (aAddon.optionsType == AddonManager.OPTIONS_TYPE_INLINE ||
          aAddon.optionsType == AddonManager.OPTIONS_TYPE_INLINE_INFO);
}

function openOptionsInTab(optionsURL) {
  let mainWindow = getMainWindow();
  if ("switchToTabHavingURI" in mainWindow) {
    mainWindow.switchToTabHavingURI(optionsURL, true);
    return true;
  }
  return false;
}

function formatDate(aDate) {
  return Cc["@mozilla.org/intl/scriptabledateformat;1"]
           .getService(Ci.nsIScriptableDateFormat)
           .FormatDate("",
                       Ci.nsIScriptableDateFormat.dateFormatLong,
                       aDate.getFullYear(),
                       aDate.getMonth() + 1,
                       aDate.getDate()
                       );
}


function hasPermission(aAddon, aPerm) {
  var perm = AddonManager["PERM_CAN_" + aPerm.toUpperCase()];
  return !!(aAddon.permissions & perm);
}


function isPending(aAddon, aAction) {
  var action = AddonManager["PENDING_" + aAction.toUpperCase()];
  return !!(aAddon.pendingOperations & action);
}

function isInState(aInstall, aState) {
  var state = AddonManager["STATE_" + aState.toUpperCase()];
  return aInstall.state == state;
}

function shouldShowVersionNumber(aAddon) {
  if (!aAddon.version)
    return false;

  // The version number is hidden for lightweight themes.
  if (aAddon.type == "theme")
    return !/@personas\.mozilla\.org$/.test(aAddon.id);

  return true;
}

function createItem(aObj, aIsInstall, aIsRemote) {
  let item = document.createElement("richlistitem");

  item.setAttribute("class", "addon addon-view");
  item.setAttribute("name", aObj.name);
  item.setAttribute("type", aObj.type);
  item.setAttribute("remote", !!aIsRemote);

  if (aIsInstall) {
    item.mInstall = aObj;

    if (aObj.state != AddonManager.STATE_INSTALLED) {
      item.setAttribute("status", "installing");
      return item;
    }
    aObj = aObj.addon;
  }

  item.mAddon = aObj;

  item.setAttribute("status", "installed");

  // set only attributes needed for sorting and XBL binding,
  // the binding handles the rest
  item.setAttribute("value", aObj.id);

  if (aObj.type == "experiment") {
    item.endDate = getExperimentEndDate(aObj);
  }

  return item;
}

function sortElements(aElements, aSortBy, aAscending) {
  // aSortBy is an Array of attributes to sort by, in decending
  // order of priority.

  const DATE_FIELDS = ["updateDate"];
  const NUMERIC_FIELDS = ["size", "relevancescore", "purchaseAmount"];

  // We're going to group add-ons into the following buckets:
  //
  //  enabledInstalled
  //    * Enabled
  //    * Incompatible but enabled because compatibility checking is off
  //    * Waiting to be installed
  //    * Waiting to be enabled
  //
  //  pendingDisable
  //    * Waiting to be disabled
  //
  //  pendingUninstall
  //    * Waiting to be removed
  //
  //  disabledIncompatibleBlocked
  //    * Disabled
  //    * Incompatible
  //    * Blocklisted

  const UISTATE_ORDER = ["enabled", "askToActivate", "pendingDisable",
                         "pendingUninstall", "disabled"];

  function dateCompare(a, b) {
    var aTime = a.getTime();
    var bTime = b.getTime();
    if (aTime < bTime)
      return -1;
    if (aTime > bTime)
      return 1;
    return 0;
  }

  function numberCompare(a, b) {
    return a - b;
  }

  function stringCompare(a, b) {
    return a.localeCompare(b);
  }

  function uiStateCompare(a, b) {
    // If we're in descending order, swap a and b, because
    // we don't ever want to have descending uiStates
    if (!aAscending)
      [a, b] = [b, a];

    return (UISTATE_ORDER.indexOf(a) - UISTATE_ORDER.indexOf(b));
  }

  function getValue(aObj, aKey) {
    if (!aObj)
      return null;

    if (aObj.hasAttribute(aKey))
      return aObj.getAttribute(aKey);

    var addon = aObj.mAddon || aObj.mInstall;
    var addonType = aObj.mAddon && AddonManager.addonTypes[aObj.mAddon.type];

    if (!addon)
      return null;

    if (aKey == "uiState") {
      if (addon.pendingOperations == AddonManager.PENDING_DISABLE)
        return "pendingDisable";
      if (addon.pendingOperations == AddonManager.PENDING_UNINSTALL)
        return "pendingUninstall";
      if (!addon.isActive &&
          (addon.pendingOperations != AddonManager.PENDING_ENABLE &&
           addon.pendingOperations != AddonManager.PENDING_INSTALL))
        return "disabled";
      if (addonType && (addonType.flags & AddonManager.TYPE_SUPPORTS_ASK_TO_ACTIVATE) &&
          addon.userDisabled == AddonManager.STATE_ASK_TO_ACTIVATE)
        return "askToActivate";
      else
        return "enabled";
    }

    return addon[aKey];
  }

  // aSortFuncs will hold the sorting functions that we'll
  // use per element, in the correct order.
  var aSortFuncs = [];

  for (let i = 0; i < aSortBy.length; i++) {
    var sortBy = aSortBy[i];

    aSortFuncs[i] = stringCompare;

    if (sortBy == "uiState")
      aSortFuncs[i] = uiStateCompare;
    else if (DATE_FIELDS.indexOf(sortBy) != -1)
      aSortFuncs[i] = dateCompare;
    else if (NUMERIC_FIELDS.indexOf(sortBy) != -1)
      aSortFuncs[i] = numberCompare;
  }


  aElements.sort(function elementsSort(a, b) {
    if (!aAscending)
      [a, b] = [b, a];

    for (let i = 0; i < aSortFuncs.length; i++) {
      var sortBy = aSortBy[i];
      var aValue = getValue(a, sortBy);
      var bValue = getValue(b, sortBy);

      if (!aValue && !bValue)
        return 0;
      if (!aValue)
        return -1;
      if (!bValue)
        return 1;
      if (aValue != bValue) {
        var result = aSortFuncs[i](aValue, bValue);

        if (result != 0)
          return result;
      }
    }

    // If we got here, then all values of a and b
    // must have been equal.
    return 0;

  });
}

function sortList(aList, aSortBy, aAscending) {
  var elements = Array.slice(aList.childNodes, 0);
  sortElements(elements, [aSortBy], aAscending);

  while (aList.listChild)
    aList.removeChild(aList.lastChild);

  for (let element of elements)
    aList.appendChild(element);
}

function getAddonsAndInstalls(aType, aCallback) {
  let addons = null, installs = null;
  let types = (aType != null) ? [aType] : null;

  AddonManager.getAddonsByTypes(types, function getAddonsAndInstalls_getAddonsByTypes(aAddonsList) {
    addons = aAddonsList;
    if (installs != null)
      aCallback(addons, installs);
  });

  AddonManager.getInstallsByTypes(types, function getAddonsAndInstalls_getInstallsByTypes(aInstallsList) {
    // skip over upgrade installs and non-active installs
    installs = aInstallsList.filter(function installsFilter(aInstall) {
      return !(aInstall.existingAddon ||
               aInstall.state == AddonManager.STATE_AVAILABLE);
    });

    if (addons != null)
      aCallback(addons, installs)
  });
}

function doPendingUninstalls(aListBox) {
  // Uninstalling add-ons can mutate the list so find the add-ons first then
  // uninstall them
  var items = [];
  var listitem = aListBox.firstChild;
  while (listitem) {
    if (listitem.getAttribute("pending") == "uninstall" &&
        !listitem.isPending("uninstall"))
      items.push(listitem.mAddon);
    listitem = listitem.nextSibling;
  }

  for (let addon of items)
    addon.uninstall();
}

var gCategories = {
  node: null,
  _search: null,

  initialize: function gCategories_initialize() {
    this.node = document.getElementById("categories");
    this._search = this.get("addons://search/");

    var types = AddonManager.addonTypes;
    for (var type in types)
      this.onTypeAdded(types[type]);

    AddonManager.addTypeListener(this);

    try {
      this.node.value = Services.prefs.getCharPref(PREF_UI_LASTCATEGORY);
    } catch (e) { }

    // If there was no last view or no existing category matched the last view
    // then the list will default to selecting the search category and we never
    // want to show that as the first view so switch to the default category
    if (!this.node.selectedItem || this.node.selectedItem == this._search)
      this.node.value = gViewDefault;

    var self = this;
    this.node.addEventListener("select", function node_onSelected() {
      gViewController.loadView(self.node.selectedItem.value);
    }, false);

    this.node.addEventListener("click", function node_onClicked(aEvent) {
      var selectedItem = self.node.selectedItem;
      if (aEvent.target.localName == "richlistitem" &&
          aEvent.target == selectedItem) {
        var viewId = selectedItem.value;

        if (gViewController.parseViewId(viewId).type == "search") {
          viewId += encodeURIComponent(gSearchView.searchQuery);
        }

        gViewController.loadView(viewId);
      }
    }, false);
  },

  shutdown: function gCategories_shutdown() {
    AddonManager.removeTypeListener(this);
  },

  _insertCategory: function gCategories_insertCategory(aId, aName, aView, aPriority, aStartHidden) {
    // If this category already exists then don't re-add it
    if (document.getElementById("category-" + aId))
      return;

    var category = document.createElement("richlistitem");
    category.setAttribute("id", "category-" + aId);
    category.setAttribute("value", aView);
    category.setAttribute("class", "category");
    category.setAttribute("name", aName);
    category.setAttribute("tooltiptext", aName);
    category.setAttribute("priority", aPriority);
    category.setAttribute("hidden", aStartHidden);

    var node;
    for (node of this.node.children) {
      var nodePriority = parseInt(node.getAttribute("priority"));
      // If the new type's priority is higher than this one then this is the
      // insertion point
      if (aPriority < nodePriority)
        break;
      // If the new type's priority is lower than this one then this is isn't
      // the insertion point
      if (aPriority > nodePriority)
        continue;
      // If the priorities are equal and the new type's name is earlier
      // alphabetically then this is the insertion point
      if (String.localeCompare(aName, node.getAttribute("name")) < 0)
        break;
    }

    this.node.insertBefore(category, node);
  },

  _removeCategory: function gCategories_removeCategory(aId) {
    var category = document.getElementById("category-" + aId);
    if (!category)
      return;

    // If this category is currently selected then switch to the default view
    if (this.node.selectedItem == category)
      gViewController.replaceView(gViewDefault);

    this.node.removeChild(category);
  },

  onTypeAdded: function gCategories_onTypeAdded(aType) {
    // Ignore types that we don't have a view object for
    if (!(aType.viewType in gViewController.viewObjects))
      return;

    var aViewId = "addons://" + aType.viewType + "/" + aType.id;

    var startHidden = false;
    if (aType.flags & AddonManager.TYPE_UI_HIDE_EMPTY) {
      var prefName = PREF_UI_TYPE_HIDDEN.replace("%TYPE%", aType.id);
      try {
        startHidden = Services.prefs.getBoolPref(prefName);
      }
      catch (e) {
        // Default to hidden
        startHidden = true;
      }

      var self = this;
      gPendingInitializations++;
      getAddonsAndInstalls(aType.id, function onTypeAdded_getAddonsAndInstalls(aAddonsList, aInstallsList) {
        var hidden = (aAddonsList.length == 0 && aInstallsList.length == 0);
        var item = self.get(aViewId);

        // Don't load view that is becoming hidden
        if (hidden && aViewId == gViewController.currentViewId)
          gViewController.loadView(gViewDefault);

        item.hidden = hidden;
        Services.prefs.setBoolPref(prefName, hidden);

        if (aAddonsList.length > 0 || aInstallsList.length > 0) {
          notifyInitialized();
          return;
        }

        gEventManager.registerInstallListener({
          onDownloadStarted: function gCategories_onDownloadStarted(aInstall) {
            this._maybeShowCategory(aInstall);
          },

          onInstallStarted: function gCategories_onInstallStarted(aInstall) {
            this._maybeShowCategory(aInstall);
          },

          onInstallEnded: function gCategories_onInstallEnded(aInstall, aAddon) {
            this._maybeShowCategory(aAddon);
          },

          onExternalInstall: function gCategories_onExternalInstall(aAddon, aExistingAddon, aRequiresRestart) {
            this._maybeShowCategory(aAddon);
          },

          _maybeShowCategory: function gCategories_maybeShowCategory(aAddon) {
            if (aType.id == aAddon.type) {
              self.get(aViewId).hidden = false;
              Services.prefs.setBoolPref(prefName, false);
              gEventManager.unregisterInstallListener(this);
            }
          }
        });

        notifyInitialized();
      });
    }

    this._insertCategory(aType.id, aType.name, aViewId, aType.uiPriority,
                         startHidden);
  },

  onTypeRemoved: function gCategories_onTypeRemoved(aType) {
    this._removeCategory(aType.id);
  },

  get selected() {
    return this.node.selectedItem ? this.node.selectedItem.value : null;
  },

  select: function gCategories_select(aId, aPreviousView) {
    var view = gViewController.parseViewId(aId);
    aId = aId.replace(/\?.*/, "");

    Services.prefs.setCharPref(PREF_UI_LASTCATEGORY, aId);

    if (this.node.selectedItem &&
        this.node.selectedItem.value == aId) {
      this.node.selectedItem.hidden = false;
      this.node.selectedItem.disabled = false;
      return;
    }

    if (view.type == "search")
      var item = this._search;
    else
      var item = this.get(aId);

    if (item) {
      item.hidden = false;
      item.disabled = false;
      this.node.suppressOnSelect = true;
      this.node.selectedItem = item;
      this.node.suppressOnSelect = false;
      this.node.ensureElementIsVisible(item);
    }
  },

  get: function gCategories_get(aId) {
    var items = document.getElementsByAttribute("value", aId);
    if (items.length)
      return items[0];
    return null;
  },
};

var gCachedAddons = {};

var gSearchView = {
  node: null,
  _filter: null,
  _loading: null,
  _listBox: null,
  _emptyNotice: null,
  _recommendedHeader: null,
  _allRecommendedLink: null,
  _allResultsLink: null,
  _clearButton: null,
  _lastQuery: null,
  _lastRemoteTotal: 0,
  _pendingSearches: 0,
  _search: null,

  initialize: function gSearchView_initialize() {
    this.node = document.getElementById("search-view");
    this._loading = document.getElementById("search-loading");
    this._listBox = document.getElementById("search-list");
    this._emptyNotice = document.getElementById("search-list-empty");
    this._recommendedHeader = document.getElementById("search-recommended-header");
    this._allRecommendedLink = document.getElementById("search-allrecommended-link");
    this._allResultsLink = document.getElementById("search-allresults-link");
    this._clearButton = document.getElementById("search-clear-button");

    var self = this;

    this._search = document.getElementById("header-search");
    this._search.addEventListener("command", function search_onCommand(aEvent) {
      var query = aEvent.target.value;

      gViewController.loadView("addons://search/" + encodeURIComponent(query));
    }, false);

    this._clearButton.addEventListener("command", function search_clearButtonOnCommand(aEvent) {
      self._search.reset();
      gViewController.loadView("addons://search/");
    }, false);
  },

  shutdown: function gSearchView_shutdown() {
    if (AddonRepository.isSearching)
      AddonRepository.cancelSearch();
  },

  get isSearching() {
    return this._pendingSearches > 0;
  },

  show: function gSearchView_show(aQuery, aRequest) {
    gEventManager.registerInstallListener(this);

    this.showEmptyNotice(false);
    this.showHeaderAndFooter(0);
    this.showLoading(true);

    aQuery = aQuery.trim().toLocaleLowerCase();
    if (this._lastQuery == aQuery) {
      this.updateView();
      gViewController.notifyViewChanged();
      return;
    }
    this._lastQuery = aQuery;

    if (AddonRepository.isSearching)
      AddonRepository.cancelSearch();

    while (this._listBox.childNodes[1].localName == "richlistitem")
      this._listBox.removeChild(this._listBox.childNodes[1]);

    var self = this;
    gCachedAddons = {};
    this._pendingSearches = 2;

    var elements = [];

    function createSearchResults(aObjsList, aIsInstall) {
      for (let index in aObjsList) {
        let obj = aObjsList[index];
        let score = aObjsList.length - index;
 
        let item = createItem(obj, aIsInstall, true);
        item.setAttribute("relevancescore", score);
        gCachedAddons[obj.id] = obj;

        elements.push(item);
      }
    }

    function finishSearch(createdCount) {
      if (elements.length > 0) {
        sortElements(elements, "relevancescore", false);
        for (let element of elements)
          self._listBox.insertBefore(element, self._listBox.lastChild);
        self.updateListAttributes();
      }

      self._pendingSearches--;
      self.updateView();

      if (!self.isSearching)
        gViewController.notifyViewChanged();
    }

    getAddonsAndInstalls(null, function show_getAddonsAndInstalls(aAddons, aInstalls) {
      if (gViewController && aRequest != gViewController.currentViewRequest)
        return;

      finishSearch();
    });

    var maxRemoteResults = 0;
    try {
      maxRemoteResults = Services.prefs.getIntPref(PREF_MAXRESULTS);
    } catch(e) {}

    if (maxRemoteResults <= 0) {
      finishSearch(0);
      return;
    }

    var callback = {
      searchFailed: function show_SearchFailed() {
        if (gViewController && aRequest != gViewController.currentViewRequest)
          return;

        self._lastRemoteTotal = 0;

        // XXXunf Better handling of AMO search failure. See bug 579502
        finishSearch(0); // Silently fail
      },

      searchSucceeded: function show_SearchSucceeded(aAddonsList, aAddonCount, aTotalResults) {
        if (gViewController && aRequest != gViewController.currentViewRequest)
          return;

        if (aTotalResults > maxRemoteResults)
          self._lastRemoteTotal = aTotalResults;
        else
          self._lastRemoteTotal = 0;

        var createdCount = createSearchResults(aAddonsList, false);
        finishSearch(createdCount);
      }
    };

    if (aQuery.length == 0)
      AddonRepository.retrieveRecommendedAddons(maxRemoteResults, callback);
    else
      AddonRepository.searchAddons(aQuery, maxRemoteResults, callback);
  },

  showLoading: function gSearchView_showLoading(aLoading) {
    this._loading.hidden = !aLoading;
    this._listBox.hidden = aLoading;
  },

  updateView: function gSearchView_updateView() {
    this._listBox.setAttribute("remote", true);

    this.showLoading(this.isSearching);
    if (!this.isSearching) {
      var isEmpty = true;
      var results = this._listBox.getElementsByTagName("richlistitem");
      for (let result of results) {
        var isRemote = (result.getAttribute("remote") == "true");
        if (isRemote) {
          isEmpty = false;
          break;
        }
      }

      this.showEmptyNotice(isEmpty);
      this.showHeaderAndFooter(this._lastRemoteTotal, this._lastQuery.length == 0);
    }

    gViewController.updateCommands();
  },

  hide: function gSearchView_hide() {
    gEventManager.unregisterInstallListener(this);
    doPendingUninstalls(this._listBox);
  },

  showEmptyNotice: function gSearchView_showEmptyNotice(aShow) {
    this._emptyNotice.hidden = !aShow;
    this._listBox.hidden = aShow;
  },

  showHeaderAndFooter: function gSearchView_showHeaderAndFooter(aTotalResults, aRecommended) {
    if (aRecommended) {
      this._recommendedHeader.hidden = false;

      this._allRecommendedLink.setAttribute("href",
                                            Services.urlFormatter.formatURLPref("extensions.oam.recommended.browseURL"));
      this._allRecommendedLink.hidden = false;
      this._allResultsLink.hidden = true;
      this._clearButton.hidden = true;
      return;
    }

    this._recommendedHeader.hidden = true;
    this._allRecommendedLink.hidden = true;

    this._clearButton.hidden = false;

    if (aTotalResults == 0) {
      this._allResultsLink.hidden = true;
      return;
    }

    var linkStr = gStrings.ext.GetStringFromName("showAllSearchResults");
    linkStr = PluralForm.get(aTotalResults, linkStr);
    linkStr = linkStr.replace("#1", aTotalResults);
    this._allResultsLink.setAttribute("value", linkStr);

    this._allResultsLink.setAttribute("href",
                                      AddonRepository.getSearchURL(this._lastQuery));
    this._allResultsLink.hidden = false;
 },

  updateListAttributes: function gSearchView_updateListAttributes() {
    var item = this._listBox.querySelector("richlistitem[remote='true'][first]");
    if (item)
      item.removeAttribute("first");
    item = this._listBox.querySelector("richlistitem[remote='true'][last]");
    if (item)
      item.removeAttribute("last");
    var items = this._listBox.querySelectorAll("richlistitem[remote='true']");
    if (items.length > 0) {
      items[0].setAttribute("first", true);
      items[items.length - 1].setAttribute("last", true);
    }

    item = this._listBox.querySelector("richlistitem:not([remote='true'])[first]");
    if (item)
      item.removeAttribute("first");
    item = this._listBox.querySelector("richlistitem:not([remote='true'])[last]");
    if (item)
      item.removeAttribute("last");
    items = this._listBox.querySelectorAll("richlistitem:not([remote='true'])");
    if (items.length > 0) {
      items[0].setAttribute("first", true);
      items[items.length - 1].setAttribute("last", true);
    }

  },

  onDownloadCancelled: function gSearchView_onDownloadCancelled(aInstall) {
    this.removeInstall(aInstall);
  },

  onInstallCancelled: function gSearchView_onInstallCancelled(aInstall) {
    this.removeInstall(aInstall);
  },

  removeInstall: function gSearchView_removeInstall(aInstall) {
    for (let item of this._listBox.childNodes) {
      if (item.mInstall == aInstall) {
        this._listBox.removeChild(item);
        return;
      }
    }
  },

  getSelectedAddon: function gSearchView_getSelectedAddon() {
    var item = this._listBox.selectedItem;
    if (item)
      return item.mAddon;
    return null;
  },

  getListItemForID: function gSearchView_getListItemForID(aId) {
    var listitem = this._listBox.firstChild;
    while (listitem) {
      if (listitem.getAttribute("status") == "installed" && listitem.mAddon.id == aId)
        return listitem;
      listitem = listitem.nextSibling;
    }
    return null;
  },
      
  get searchQuery() {
    return this._search.value;
  },
    
  set searchQuery(aQuery) {
    this._search.value = aQuery;
  }
};


var gListView = {
  node: null,
  _listBox: null,
  _emptyNotice: null,
  _type: null,
  _themeSplitter: null,
  _themePreviewArea: null,

  initialize: function gListView_initialize() {
    this.node = document.getElementById("list-view");
    this._listBox = document.getElementById("addon-list");
    this._emptyNotice = document.getElementById("addon-list-empty");
    this._themeSplitter = document.getElementById("themeSplitter");
    this._themePreviewArea = document.getElementById("themePreviewArea");

    var self = this;

    this._listBox.addEventListener("select", function listbox_onSelect(aEvent) {
      var item = self._listBox.selectedItem;
      var screenshotbox = document.getElementById("previewImageDeck");

      if (!item || self._type != "theme") {
        screenshotbox.selectedIndex = 0;
        return;
      }

      var screenshot = document.getElementById("screenshotImage");
      var addon = item.mAddon;

      if (addon.screenshots && addon.screenshots.length > 0) {
        if (addon.screenshots[0].thumbnailURL)
          screenshot.src = addon.screenshots[0].thumbnailURL;
        else
          screenshot.src = addon.screenshots[0].url;
        screenshot.setAttribute("loading", "true");
        screenshotbox.selectedIndex = 2;
      } else
        screenshotbox.selectedIndex = 1;
    }, false);

    let screenshot = document.getElementById("screenshotImage");
    screenshot.addEventListener("load", function(event) {
      this.removeAttribute("loading");
    });
    screenshot.addEventListener("error", function(event) {
      this.setAttribute("loading", "error");
    });
  },

  show: function gListView_show(aType, aRequest) {
    if (!(aType in AddonManager.addonTypes))
      throw Components.Exception("Attempting to show unknown type " + aType, Cr.NS_ERROR_INVALID_ARG);

    this._type = aType;
    this.node.setAttribute("type", aType);
    this.showEmptyNotice(false);

    while (this._listBox.itemCount > 0)
      this._listBox.removeItemAt(0);

    if (aType == "plugin") {
      navigator.plugins.refresh(false);
    }

    this._themeSplitter.hidden = aType != "theme";
    this._themePreviewArea.hidden = aType != "theme";

    getAddonsAndInstalls(aType, (aAddonsList, aInstallsList) => {
      if (gViewController && aRequest != gViewController.currentViewRequest)
        return;

      var elements = [];

      for (let addonItem of aAddonsList)
        elements.push(createItem(addonItem));

      for (let installItem of aInstallsList)
        elements.push(createItem(installItem, true));

      this.showEmptyNotice(elements.length == 0);
      if (elements.length > 0) {
        sortElements(elements, ["uiState", "name"], true);
        for (let element of elements)
          this._listBox.appendChild(element);
      }

      gEventManager.registerInstallListener(this);
      gViewController.updateCommands();
      gViewController.notifyViewChanged();
    });
  },

  hide: function gListView_hide() {
    gEventManager.unregisterInstallListener(this);
    doPendingUninstalls(this._listBox);
  },

  showEmptyNotice: function gListView_showEmptyNotice(aShow) {
    this._emptyNotice.hidden = !aShow;
    this._listBox.hidden = aShow;
  },

  onExternalInstall: function gListView_onExternalInstall(aAddon, aExistingAddon, aRequiresRestart) {
    // The existing list item will take care of upgrade installs
    if (aExistingAddon)
      return;

    this.addItem(aAddon);
  },

  onDownloadStarted: function gListView_onDownloadStarted(aInstall) {
    this.addItem(aInstall, true);
  },

  onInstallStarted: function gListView_onInstallStarted(aInstall) {
    this.addItem(aInstall, true);
  },

  onDownloadCancelled: function gListView_onDownloadCancelled(aInstall) {
    this.removeItem(aInstall, true);
  },

  onInstallCancelled: function gListView_onInstallCancelled(aInstall) {
    this.removeItem(aInstall, true);
  },

  onInstallEnded: function gListView_onInstallEnded(aInstall) {
    // Remove any install entries for upgrades, their status will appear against
    // the existing item
    if (aInstall.existingAddon)
      this.removeItem(aInstall, true);

    if (aInstall.addon.type == "experiment") {
      let item = this.getListItemForID(aInstall.addon.id);
      if (item) {
        item.endDate = getExperimentEndDate(aInstall.addon);
      }
    }
  },

  addItem: function gListView_addItem(aObj, aIsInstall) {
    if (aObj.type != this._type)
      return;

    if (aIsInstall && aObj.existingAddon)
      return;

    let prop = aIsInstall ? "mInstall" : "mAddon";
    for (let item of this._listBox.childNodes) {
      if (item[prop] == aObj)
        return;
    }

    let item = createItem(aObj, aIsInstall);
    this._listBox.insertBefore(item, this._listBox.firstChild);
    this.showEmptyNotice(false);
  },

  removeItem: function gListView_removeItem(aObj, aIsInstall) {
    let prop = aIsInstall ? "mInstall" : "mAddon";

    for (let item of this._listBox.childNodes) {
      if (item[prop] == aObj) {
        this._listBox.removeChild(item);
        this.showEmptyNotice(this._listBox.itemCount == 0);
        return;
      }
    }
  },

  getSelectedAddon: function gListView_getSelectedAddon() {
    var item = this._listBox.selectedItem;
    if (item)
      return item.mAddon;
    return null;
  },

  getListItemForID: function gListView_getListItemForID(aId) {
    var listitem = this._listBox.firstChild;
    while (listitem) {
      if (listitem.getAttribute("status") == "installed" && listitem.mAddon.id == aId)
        return listitem;
      listitem = listitem.nextSibling;
    }
    return null;
  }
};


var gUpdatesView = {
  node: null,
  _listBox: null,
  _emptyNotice: null,
  _updateSelected: null,
  _categoryItem: null,
  _infoSplitter: null,
  _infoPreviewArea: null,
  _showInfo: null,

  initialize: function gUpdatesView_initialize() {
    this.node = document.getElementById("updates-view");
    this._listBox = document.getElementById("updates-list");
    this._emptyNotice = document.getElementById("updates-list-empty");
    this._infoSplitter = document.getElementById("relNotesSplitter");
    this._infoPreviewArea = document.getElementById("relNotesArea");
    this._showInfo = false;

    this._categoryItem = gCategories.get("addons://updates/");

    this.updateAvailableCount(true);

    AddonManager.addAddonListener(this);
    AddonManager.addInstallListener(this);

    var self = this;

    this._listBox.addEventListener("select", function listbox_onSelect(aEvent) {
      var item = self._listBox.selectedItem;
      var infoDeck = document.getElementById("infoDeck");

      if (!item) {
        infoDeck.selectedIndex = 0;
        return;
      }

      var infoDisplay = document.getElementById("infoDisplay");
      var addon = item.mAddon;
      var manualUpdate = item.mManualUpdate;

      infoDeck.selectedIndex = 2;

      var relNotesData = null, transformData = null;

      function showRelNotes() {
        if (!relNotesData || !transformData) {
          return;
        }

        infoDeck.selectedIndex = 4;

        var processor = Components.classes["@mozilla.org/document-transformer;1?type=xslt"]
                                  .createInstance(Components.interfaces.nsIXSLTProcessor);
        processor.flags |= Components.interfaces.nsIXSLTProcessorPrivate.DISABLE_ALL_LOADS;

        processor.importStylesheet(transformData);
        var fragment = processor.transformToFragment(relNotesData, document);
        while (infoDisplay.hasChildNodes())
          infoDisplay.removeChild(infoDisplay.firstChild);
        infoDisplay.appendChild(fragment);
      }

      function handleError() {
        dataReq.abort();
        styleReq.abort();
        infoDeck.selectedIndex = 3;
      }

      function handleResponse(aEvent) {
        var req = aEvent.target;
        var ct = req.getResponseHeader("content-type");
        if ((!ct || ct.indexOf("text/html") < 0) &&
            req.responseXML &&
            req.responseXML.documentElement.namespaceURI != XMLURI_PARSE_ERROR) {
          if (req == dataReq)
            relNotesData = req.responseXML;
          else
            transformData = req.responseXML;
          showRelNotes();
        } else {
          handleError();
        }
      }

      var uri = manualUpdate ?
                manualUpdate.releaseNotesURI :
                addon.releaseNotesURI;
      if (!uri) {
        infoDeck.selectedIndex = 1;
        return;
      }
      var dataReq = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
                          .createInstance(Components.interfaces.nsIXMLHttpRequest);
      dataReq.open("GET", uri.spec, true);
      dataReq.addEventListener("load", handleResponse, false);
      dataReq.addEventListener("error", handleError, false);
      dataReq.send(null);

      var styleReq = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
                          .createInstance(Components.interfaces.nsIXMLHttpRequest);
      styleReq.open("GET", UPDATES_RELEASENOTES_TRANSFORMFILE, true);
      styleReq.addEventListener("load", handleResponse, false);
      styleReq.addEventListener("error", handleError, false);
      styleReq.send(null);
    }, false);

    this._updateSelected = document.getElementById("installUpdatesAllButton");
  },

  shutdown: function gUpdatesView_shutdown() {
    AddonManager.removeAddonListener(this);
    AddonManager.removeInstallListener(this);
  },

  show: function gUpdatesView_show(aType, aRequest) {
    document.getElementById("updates-list-empty").hidden = false;
    this.showEmptyNotice(false);

    this._infoSplitter.hidden = !this._showInfo;
    this._infoPreviewArea.hidden = !this._showInfo;

    while (this._listBox.itemCount > 0)
      this._listBox.removeItemAt(0);

    this._showUpdates(false, aRequest);
  },

  hide: function gUpdatesView_hide() {
    doPendingUninstalls(this._listBox);
  },

  _showUpdates: function gUpdatesView_showUpdates(aIsRefresh, aRequest) {
    /* Disable the Update Selected button so it can't get clicked
       before everything is initialized asynchronously.
       It will get re-enabled by maybeDisableUpdateSelected(). */
    this._updateSelected.disabled = true;

    var self = this;
    AddonManager.getAllInstalls(function showUpdates_getAllInstalls(aInstallsList) {
      if (!aIsRefresh && gViewController && aRequest &&
          aRequest != gViewController.currentViewRequest)
        return;

      if (aIsRefresh) {
        self.showEmptyNotice(false);

        while (self._listBox.childNodes.length > 0)
          self._listBox.removeChild(self._listBox.firstChild);
      }

      var elements = [];

      for (let install of aInstallsList) {
        if (!self.isManualUpdate(install))
          continue;

        let item = createItem(install.existingAddon);
        item.setAttribute("upgrade", true);
        item.addEventListener("IncludeUpdateChanged", function item_onIncludeUpdateChanged() {
          self.maybeDisableUpdateSelected();
        }, false);
        elements.push(item);
      }

      self.showEmptyNotice(elements.length == 0);
      if (elements.length > 0) {
        sortElements(elements, "relevancescore", false);
        for (let element of elements)
          self._listBox.appendChild(element);
      }

      gViewController.notifyViewChanged();
    });
  },

  showEmptyNotice: function gUpdatesView_showEmptyNotice(aShow) {
    this._emptyNotice.hidden = !aShow;
    this._listBox.hidden = aShow;
  },

  isManualUpdate: function gUpdatesView_isManualUpdate(aInstall, aOnlyAvailable) {
    var isManual = aInstall.existingAddon &&
                   !AddonManager.shouldAutoUpdate(aInstall.existingAddon);
    if (isManual && aOnlyAvailable)
      return isInState(aInstall, "available");
    return isManual;
  },

  maybeRefresh: function gUpdatesView_maybeRefresh() {
    if (gViewController.currentViewId == "addons://updates/")
      this._showUpdates(true);
    this.updateAvailableCount();
  },

  updateAvailableCount: function gUpdatesView_updateAvailableCount(aInitializing) {
    if (aInitializing)
      gPendingInitializations++;
    var self = this;
    AddonManager.getAllInstalls(function updateAvailableCount_getAllInstalls(aInstallsList) {
      var count = aInstallsList.filter(function installListFilter(aInstall) {
        return self.isManualUpdate(aInstall, true);
      }).length;
      self._categoryItem.disabled = gViewController.currentViewId != "addons://updates/" &&
                                    count == 0;
      if (aInitializing)
        notifyInitialized();
    });
  },

  maybeDisableUpdateSelected: function gUpdatesView_maybeDisableUpdateSelected() {
    for (let item of this._listBox.childNodes) {
      if (item.includeUpdate) {
        this._updateSelected.disabled = false;
        return;
      }
    }
    this._updateSelected.disabled = true;
  },

  installSelected: function gUpdatesView_installSelected() {
    for (let item of this._listBox.childNodes) {
      if (item.includeUpdate)
        item.upgrade();
    }

    this._updateSelected.disabled = true;
  },

  getSelectedAddon: function gUpdatesView_getSelectedAddon() {
    var item = this._listBox.selectedItem;
    if (item)
      return item.mAddon;
    return null;
  },

  getListItemForID: function gUpdatesView_getListItemForID(aId) {
    var listitem = this._listBox.firstChild;
    while (listitem) {
      if (listitem.mAddon.id == aId)
        return listitem;
      listitem = listitem.nextSibling;
    }
    return null;
  },

  onNewInstall: function gUpdatesView_onNewInstall(aInstall) {
    if (!this.isManualUpdate(aInstall))
      return;
    this.maybeRefresh();
  },

  onInstallStarted: function gUpdatesView_onInstallStarted(aInstall) {
    this.updateAvailableCount();
  },

  onInstallCancelled: function gUpdatesView_onInstallCancelled(aInstall) {
    if (!this.isManualUpdate(aInstall))
      return;
    this.maybeRefresh();
  },

  onPropertyChanged: function gUpdatesView_onPropertyChanged(aAddon, aProperties) {
    if (aProperties.indexOf("applyBackgroundUpdates") != -1)
      this.updateAvailableCount();
  },

  toggleUpdateInfo: function gUpdatesView_toggleUpdateInfo(aShow) {
    this._showInfo = aShow;
    this._infoSplitter.hidden = !this._showInfo;
    this._infoPreviewArea.hidden = !this._showInfo;
  }
};

function debuggingPrefChanged() {
  gViewController.updateState();
  gViewController.updateCommands();
  gViewController.notifyViewChanged();
}

var gDragDrop = {
  onDragOver: function gDragDrop_onDragOver(aEvent) {
    var types = aEvent.dataTransfer.types;
    if (types.contains("text/uri-list") ||
        types.contains("text/x-moz-url") ||
        types.contains("application/x-moz-file"))
      aEvent.preventDefault();
  },

  onDrop: function gDragDrop_onDrop(aEvent) {
    var dataTransfer = aEvent.dataTransfer;
    var urls = [];

    // Convert every dropped item into a url
    for (var i = 0; i < dataTransfer.mozItemCount; i++) {
      var url = dataTransfer.mozGetDataAt("text/uri-list", i);
      if (url) {
        urls.push(url);
        continue;
      }

      url = dataTransfer.mozGetDataAt("text/x-moz-url", i);
      if (url) {
        urls.push(url.split("\n")[0]);
        continue;
      }

      var file = dataTransfer.mozGetDataAt("application/x-moz-file", i);
      if (file) {
        urls.push(Services.io.newFileURI(file).spec);
        continue;
      }
    }

    var pos = 0;
    var installs = [];

    function buildNextInstall() {
      if (pos == urls.length) {
        if (installs.length > 0) {
          // Display the normal install confirmation for the installs
          AddonManager.installAddonsFromWebpage("application/x-xpinstall",
                                                getBrowserElement(), null, installs);
        }
        return;
      }

      AddonManager.getInstallForURL(urls[pos++], function onDrop_getInstallForURL(aInstall) {
        installs.push(aInstall);
        buildNextInstall();
      }, "application/x-xpinstall");
    }

    buildNextInstall();

    aEvent.preventDefault();
  }
};


var gCommandBar = {
  node: null,

  _showUpdateInfoButton: null,
  _hideUpdateInfoButton: null,
  _installFileButton: null,
  _checkUpdatesAllButton: null,
  _getMoreLink: null,
  _installUpdatesAllButton: null,

  initialize: function gCmdBar_initialize() {
    this.node = document.getElementById("command-bar");

    this._showUpdateInfoButton = document.getElementById("showUpdateInfoButton");
    this._hideUpdateInfoButton = document.getElementById("hideUpdateInfoButton");
    this._installFileButton = document.getElementById("installFileButton");
    this._checkUpdatesAllButton = document.getElementById("checkUpdatesAllButton");
    this._getMoreLink = document.getElementById("getMore");
    this._installUpdatesAllButton = document.getElementById("installUpdatesAllButton");
  },

  onViewChanged: function gCmdBar_onViewChanged(aType, aParam) {
    var hideInstallButton = Services.prefs.getBoolPref("extensions.oam.hideInstallButton");

    var tooltipAttribute = "tooltiptextaddons";
    if (aParam == "theme")
      tooltipAttribute = "tooltiptextthemes";
    else if (aParam == "plugin")
      tooltipAttribute = "tooltiptextplugins";
    this._checkUpdatesAllButton.setAttribute("tooltiptext",
                                             this._checkUpdatesAllButton.getAttribute(tooltipAttribute));

    this._checkUpdatesAllButton.hidden = (aType != "list");
    if (aParam == "plugin")
      this._checkUpdatesAllButton.command = "cmd_pluginCheck";
    else
      this._checkUpdatesAllButton.command = "cmd_findAllUpdates";

    this._installFileButton.hidden = (aType == "updates") || hideInstallButton;

    var pref = "extensions.oam.getMoreExtensionsURL";
    var value = "valueextensions";
    if (aParam == "theme") {
      pref = "extensions.oam.getMoreThemesURL";
      value = "valuethemes";
    } else if (aParam == "plugin") {
      pref = "extensions.oam.getMorePluginsURL";
      value = "valueplugins";
    }
    this._getMoreLink.setAttribute("getMoreURL", Services.urlFormatter.formatURLPref(pref));
    this._getMoreLink.value = this._getMoreLink.getAttribute(value);
    this._getMoreLink.hidden = (aParam != "theme");

    this._installUpdatesAllButton.hidden = (aType != "updates");
    this._showUpdateInfoButton.hidden = (aType != "updates") || gUpdatesView._showInfo;
    this._hideUpdateInfoButton.hidden = (aType != "updates") || !gUpdatesView._showInfo;
  },

  toggleUpdateInfo: function gCmdBar_toggleUpdateInfo(aShow) {
    gUpdatesView.toggleUpdateInfo(aShow);
    this._showUpdateInfoButton.hidden = aShow;
    this._hideUpdateInfoButton.hidden = !aShow;
  }
};
