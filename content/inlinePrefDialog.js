// -*- indent-tabs-mode: nil; js-indent-level: 2 -*-

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");

function init() {
  var addon = window.arguments[0];
  var extensionsStrings = document.getElementById("extensionsStrings");
  var extensionsStrings2 = document.getElementById("extensionsStrings2");

  document.documentElement.setAttribute("addontype", addon.type);

  if (addon.iconURL) {
    var extensionIcon = document.getElementById("extensionIcon");
    extensionIcon.src = addon.iconURL;
  }

  document.title = extensionsStrings2.getFormattedString("optionsWindowTitle", [addon.name]);
  var extensionName = document.getElementById("extensionName");
  extensionName.textContent = addon.name;

  var extensionVersion = document.getElementById("extensionVersion");
  if (addon.version)
    extensionVersion.setAttribute("value", extensionsStrings.getFormattedString("aboutWindowVersionString", [addon.version]));
  else
    extensionVersion.hidden = true;

  var extensionHomepage = document.getElementById("extensionHomepage");
  var homepageURL = addon.homepageURL;
  if (homepageURL) {
    extensionHomepage.setAttribute("homepageURL", homepageURL);
    extensionHomepage.setAttribute("tooltiptext", homepageURL);
  } else {
    extensionHomepage.hidden = true;
  }

  var parent = document.getElementById("options");

  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", addon.optionsURL, true);
    xhr.responseType = "xml";
    xhr.onload = (function fillSettingsRows_onload() {
      var xml = xhr.responseXML;
      var settings = xml.querySelectorAll(":root > setting");

      var firstSetting = null;
      for (var setting of settings) {

        var desc = stripTextNodes(setting).trim();
        if (!setting.hasAttribute("desc"))
          setting.setAttribute("desc", desc);

        var type = setting.getAttribute("type");
        if (type == "file" || type == "directory")
          setting.setAttribute("fullpath", "true");

        setting = document.importNode(setting, true);
        var style = setting.getAttribute("style");
        if (style) {
          setting.removeAttribute("style");
          setting.setAttribute("style", style);
        }

        parent.appendChild(setting);
        var visible = window.getComputedStyle(setting, null).getPropertyValue("display") != "none";
        if (!firstSetting && visible) {
          setting.setAttribute("first-row", true);
          firstSetting = setting;
        }
      }

      // Ensure the page has loaded and force the XBL bindings to be synchronously applied,
      // then notify observers.
      if (firstSetting)
        firstSetting.clientTop;
      Services.obs.notifyObservers(document,
                                   AddonManager.OPTIONS_NOTIFICATION_DISPLAYED,
                                   addon.id);
      setTimeout(sizeToContent, 0);
    }).bind(this);
    xhr.onerror = function fillSettingsRows_onerror(aEvent) {
      Cu.reportError("Error " + aEvent.target.status +
                     " occurred while receiving " + addon.optionsURL);
    };
    xhr.send();
  } catch(e) {
    Cu.reportError(e);
  }

  var acceptButton = document.documentElement.getButton("accept");
  acceptButton.label = extensionsStrings.getString("aboutWindowCloseButton");
  acceptButton.focus();
}

function shutdown() {
  var addon = window.arguments[0];
  Services.obs.notifyObservers(document,
                               AddonManager.OPTIONS_NOTIFICATION_HIDDEN,
                               addon.id);
  var parent = document.getElementById("options");
  if (parent.getElementsByTagName("setting").length)
    Services.prefs.savePrefFile(null);
}

// This function removes and returns the text content of aNode without
// removing any child elements. Removing the text nodes ensures any XBL
// bindings apply properly.
function stripTextNodes(aNode) {
  var text = '';
  for (var i = 0; i < aNode.childNodes.length; i++) {
    if (aNode.childNodes[i].nodeType != document.ELEMENT_NODE) {
      text += aNode.childNodes[i].textContent;
      aNode.removeChild(aNode.childNodes[i--]);
    } else {
      text += stripTextNodes(aNode.childNodes[i]);
    }
  }
  return text;
}

function loadHomepage(aEvent) {
  openURL(aEvent.target.getAttribute("homepageURL"));
}

