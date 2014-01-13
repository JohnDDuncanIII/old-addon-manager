/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var oamObjectStylish = {
  updateStylish : function(){
    var category = gCategories.node.selectedItem.value;
    var stylish = category == "addons://list/userstyle";
    document.getElementById("install-style").hidden = !stylish;
    document.getElementById("new-style").hidden = !stylish;
    document.getElementById("update-all").hidden = !stylish;
    if (stylish){
      document.getElementById("checkUpdatesAllButton").setAttribute("stylish", "true");
    }else{
      document.getElementById("checkUpdatesAllButton").removeAttribute("stylish");
    }
    document.getElementById("view-port").hidden = stylish;
    document.getElementById("styles-container").hidden = !stylish;
  },

  stylishStartInstallFromUrls : function(b){
    var start = function(){
      b.setAttribute("disabled", "true");
    }
    var end = function(){
      b.removeAttribute("disabled");
    }
    stylishCommon.startInstallFromUrls(start, end);
  }
}

window.addEventListener("load", oamObjectStylish.updateStylish, false);
