/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var oamObjectGM = {
  updateGM : function(){
    var category = gCategories.node.selectedItem.value;
    var gm = category == "addons://list/greasemonkey-user-script";
    document.getElementById("findUpdatesUserscripts").hidden = !gm;
    if (gm){
      document.getElementById("checkUpdatesAllButton").setAttribute("gm", "true");
    }else{
      document.getElementById("checkUpdatesAllButton").removeAttribute("gm");
    }
    document.getElementById("getMoreUserscripts").hidden = !gm;
    document.getElementById("newUserscript").hidden = !gm;
  }
}

window.addEventListener("ViewChanged", oamObjectGM.updateGM, false);
