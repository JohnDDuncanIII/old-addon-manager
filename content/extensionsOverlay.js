/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

gCategories.maybeHideSearch = function() {
  var view = gViewController.parseViewId(this.node.selectedItem.value);
  this._search.disabled = view.type != "search";

  //Addition
  oamObject.updateSearchPanel();
}

var oamObject = {
  updateSearchPanel : function oamUpdateSearchPanel(){
    var view = gViewController.parseViewId(gCategories.node.selectedItem.value);
    document.getElementById("search-panel").hidden = view.type != "discover" && view.type != "search";
  },

  init : function oamInit(){
    this.updateSearchPanel;
    window.removeEventListener("load", this.init);
  },

  browseAddons : function oamBrowseAddons(){
    openURL(gDiscoverView.homepageURL.spec);
  }
}

window.addEventListener("load", oamObject.init, false);