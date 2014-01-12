/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var oamObject = {
  updateUI : function oamUpdateUI(){
    var category = gCategories.node.selectedItem.value;
    var search = category == "addons://discover/" || category == "addons://search/";
    var themes = category == "addons://list/theme";
    var plugins = category == "addons://list/plugin";
//    alert(category+' '+search+' '+themes);
    document.getElementById("search-panel").hidden = !search;

    var installFileButton = document.getElementById("installFileButton");
    var checkUpdatesAllButton = document.getElementById("checkUpdatesAllButton");
    var getMore = document.getElementById("getMore");
    installFileButton.hidden = (Services.appinfo.ID != "$TB_ID");
    checkUpdatesAllButton.hidden = search;
    getMore.hidden = !themes;

    var type = themes ? "themes" : "addons";
    var type2 = plugins ? "plugins" : type;
    var type3 = themes ? "themes" : (plugins ? "plugins" : "extensions");

    installFileButton.setAttribute("tooltiptext", installFileButton.getAttribute("tooltiptext" + type));
    checkUpdatesAllButton.setAttribute("tooltiptext", checkUpdatesAllButton.getAttribute("tooltiptext" + type2));
    getMore.setAttribute("value", getMore.getAttribute("value" + type3));
    getMore.setAttribute("type", type3);
  },

  browseAddons : function oamBrowseAddons(){
    openURL(Services.urlFormatter.formatURLPref("extensions.oam.browseAddons"));
  },

  getMore : function oamGetMore(){
    var getMore = document.getElementById("getMore");
    switch(getMore.getAttribute("type")){
      case "extensions": openURL(Services.urlFormatter.formatURLPref("extensions.oam.getMoreExtensionsURL")); return;
      case "themes": openURL(Services.urlFormatter.formatURLPref("extensions.oam.getMoreThemesURL")); return;
      case "plugins": openURL(Services.urlFormatter.formatURLPref("extensions.oam.getMorePluginsURL")); return;
    }
  }
}

window.addEventListener("ViewChanged", oamObject.updateUI, false);
