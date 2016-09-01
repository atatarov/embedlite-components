/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["OrientationChangeHandler"];

const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyServiceGetter(Services, "embedlite",
                                    "@mozilla.org/embedlite-app-service;1",
                                    "nsIEmbedAppService");

this.OrientationChangeHandler = function OrientationChangeHandler(window) {
  this.docShell = window.QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIWebNavigation)
                    .QueryInterface(Ci.nsIDocShell);

  this.webProgress = this.docShell.QueryInterface(Ci.nsIInterfaceRequestor)
                            .getInterface(Ci.nsIWebProgress);
  this.webProgress.addProgressListener(this, Ci.nsIWebProgress.NOTIFY_PROGRESS |
                                             Ci.nsIWebProgress.NOTIFY_STATE_ALL);

  this._winID = Services.embedlite.getIDByWindow(window);
  this._targetWindow = Services.embedlite.getContentWindowByID(this._winID);
  // "DomContentLoaded" event listener registered in EmbedLiteOrientationChangeHandler.js
}

OrientationChangeHandler.prototype = {
  _targetWindow: null,
  _winID: -1,
  webProgress: null,
  docShell: null,

  lastOrientation: "portrait-primary",
  isRegistered: false,
  orientationChangeSent: false,

  handleOrientationChange: function(evt) {
    let that = this;

    // Report orientation change only for the active doc shell.
    // Chrome / embedder side controls if doc shell is active or not (e.i. tab active).
    if (!that.docShell || !that.docShell.isActive) {
      return;
    }

    let newOrientation = that._targetWindow.screen.mozOrientation;
    let fullSwitch = (newOrientation.split("-")[0] ==
                      that.lastOrientation.split("-")[0]);
    that.orientationChangeSent = false;
    that.lastOrientation = newOrientation;

    function sendOrientationChanged() {
      if (that.orientationChangeSent) {
        return;
      }
      try {
        Services.embedlite.sendAsyncMessage(that._winID, "embed:contentOrientationChanged",
                                            JSON.stringify({
                                                             "orientation": that.lastOrientation
                                                           }));
        that.orientationChangeSent = true;
      } catch (e) {
        dump("EmbedLiteOrientationChangeHandler: Failed to report orientation change " + e + "\n")
      }
    }

    // 180deg rotation, no resize
    if (fullSwitch) {
      that._targetWindow.setTimeout(sendOrientationChanged);
      return;
    }

    that._targetWindow.addEventListener("resize", resizeThrottler, false);
    let resizeTimeout;
    function resizeThrottler() {
      // ignore resize events as long as an actualResizeHandler execution is in the queue
      if (!resizeTimeout) {
        resizeTimeout = that._targetWindow.setTimeout(function() {
          resizeTimeout = null;
          that._targetWindow.removeEventListener("resize", resizeThrottler, false);
          sendOrientationChanged();

          // The sendOrientationChanged will execute at a rate of 15fps
          // Noise should be small as we're only listening resizing after
          // orientation has changed.
        }, 66);
      }
    }

    // Fallback timeout 200ms.
    // When fullscreen video playback is running, noticed that
    // resizing doesn't take always place. This guarantees that
    // we will send the message back to chrome after 200ms. Normally
    // we go always through the resizeThrottler.
    that._targetWindow.setTimeout(sendOrientationChanged, 200);
  },

  registerOrientationChangeListener: function() {
    if (this.isRegistered) {
      return;
    }

    let window = this._targetWindow;
    window.screen.addEventListener("mozorientationchange", this, true);
    // This will take care of navigation between pages.
    window.addEventListener("beforeunload", this, true);
    this.isRegistered = true;

    this.webProgress.removeProgressListener(this, Ci.nsIWebProgress.NOTIFY_PROGRESS |
                                                  Ci.nsIWebProgress.NOTIFY_STATE_ALL);

    // Confirm initial orientation
    try {
      this.lastOrientation = this._targetWindow.screen.mozOrientation;
      Services.embedlite.sendAsyncMessage(this._winID, "embed:contentOrientationChanged",
                                          JSON.stringify({
                                                           "orientation": this.lastOrientation
                                                         }));
    } catch (e) {
      dump("EmbedLiteOrientationChangeHandler: Report initial orientation " + e + "\n")
    }
  },

  unregisterOrientationChangeListener: function() {
    if (this.isRegistered) {
      let window = this._targetWindow;
      this.isRegistered = false;
      if (window && window.screen) {
        window.screen.removeEventListener("mozorientationchange", this, true);
      }

      // No extra guards needed here as nsDocLoader checks
      // whether progress listener is registered or not.
      this.webProgress.addProgressListener(this, Ci.nsIWebProgress.NOTIFY_PROGRESS |
                                                 Ci.nsIWebProgress.NOTIFY_STATE_ALL);
    }
  },

  handleEvent: function(evt) {
    let window = this._targetWindow;
    switch (evt.type) {
    case "DOMContentLoaded":
      let target = evt.originalTarget;
      // ignore on frames and other documents
      if (target != window.document) {
        return;
      }
      this.registerOrientationChangeListener();
      break;
    case "mozorientationchange":
      this.handleOrientationChange(evt);
      break;
    case "beforeunload":
      this.unregisterOrientationChangeListener();
      break;
    }
  },

  // nsIWebProgressListener
  onStateChange: function(aWebProgress, aRequest, aStateFlags, aStatus) {
    if ((aStateFlags & Ci.nsIWebProgressListener.STATE_STOP) &&
        (aStateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) {
      // This is a fallback registration in case content loading
      // is stopped before dom is loaded. Could happen in slow mobile networks.
      this.registerOrientationChangeListener();
    }
  },
  onLocationChange: function() {},
  onSecurityChange: function() {},
  onProgressChange: function(aWebProgress, aRequest, aCurSelfProgress,
                             aMaxSelfProgress, aCurTotalProgress,
                             aMaxTotalProgress) {
    // Filter optimization: We're only interested about top level and we don't
    // want garbage.
    // Needed e.g. when loading raw image urls as then we don't get
    // DomContentLoaded message.
    if (aWebProgress.isTopLevel &&
        aCurTotalProgress <= aMaxTotalProgress && aMaxTotalProgress > 0 &&
        (aCurTotalProgress / aMaxTotalProgress) >= 1.0) {
        this.registerOrientationChangeListener();
    }
  },
  onStatusChange: function() { },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
                                            Ci.nsIDOMEventListener,
                                            Ci.nsISupportsWeakReference])
};
