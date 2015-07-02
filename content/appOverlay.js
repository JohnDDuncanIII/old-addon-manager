/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function toEM(aPane) {
  var theEM = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                        .getService(Components.interfaces.nsIWindowMediator)
                        .getMostRecentWindow("Extension:Manager");
  if (theEM) {
    theEM.focus();
    if (aPane)
      theEM.showView(aPane);
    return;
  }

  const EMURL = "chrome://oam/content/extensions.xul";
  const EMFEATURES = "all,dialog=no";
  if (aPane)
    window.openDialog(EMURL, "", EMFEATURES, aPane);
  else
    window.openDialog(EMURL, "", EMFEATURES);
}

function BrowserOpenAddonsMgr(aView) {
  if (aView)
    toEM(aView);
  else
    toEM();
}

function openAddonsMgr(aView) {
  if (aView)
    toEM(aView);
  else
    toEM();
}