/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*global GamepadManager*/
/*eslint no-unused-vars: ["error", { "vars": "local" }]*/


class Input {
    /**
     * Input handling for WebRTC web app
     *
     * @constructor
     * @param {Element} [element]
     *    Video element to attach events to
     * @param {function} [send]
     *    Function used to send input events to server.
     */
    constructor(element, send) {
        /**
         * @type {Element}
         */
        this.element = element;

        /**
         * @type {function}
         */
        this.send = send;

        /**
         * @type {boolean}
         */
        this.mouseRelative = false;

        /**
         * @type {Object}
         */
        this.m = null;

        /**
         * @type {Integer}
         */
        this.buttonMask = 0;

        /**
         * @type {Keyboard}
         */
        this.keyboard = null;

        /**
         * @type {GamepadManager}
         */
        this.gamepadManager = null;

        /**
         * @type {Integer}
         */
        this.x = 0;

        /**
         * @type {Integer}
         */
        this.y = 0;

        /**
         * @type {function}
         */
        this.onmenuhotkey = null;

        /**
         * @type {function}
         */
        this.onfullscreenhotkey = null;

        /**
         * @type {function}
         */
        this.ongamepadconnected = null;

        /**
         * @type {function}
         */
        this.ongamepaddisconneceted = null;

        /**
         * List of attached listeners, record keeping used to detach all.
         * @type {Array}
         */
        this.listeners = [];

        /**
         * @type {function}
         */
        this.onresizeend = null;

        // internal variables used by resize start/end functions.
        this._rtime = null;
        this._rtimeout = false;
        this._rdelta = 200;
    }

    /**
     * Handles mouse button and motion events and sends them to WebRTC app.
     * @param {MouseEvent} event
     */
    _mouseButtonMovement(event) {
        const down = (event.type === 'mousedown' ? 1 : 0);
        var data = {};

        if (event.type === 'mousemove' && !this.m) return;

        if (!document.pointerLockElement) {
            if (this.mouseRelative)
                event.target.requestPointerLock();
        }

        // Hotkey to enable pointer lock, CTRL-SHIFT-LeftButton
        if (down && event.button === 0 && event.ctrlKey && event.shiftKey) {
            event.target.requestPointerLock();
            return;
        }

        if (document.pointerLockElement) {
            // FIXME - mark as relative!
            console.warn("FIXME: Make event relative!")
            this.x = event.movementX;
            this.y = event.movementY;
        } else if (event.type === 'mousemove') {
            this.x = this._clientToServerX(event.clientX);
            this.y = this._clientToServerY(event.clientY);
            data["event"] = "MouseMove"
        }

        if (event.type === 'mousedown') {
            data["event"] = "MouseButtonPress";
        } else if (event.type === 'mouseup') {
            data["event"] = "MouseButtonRelease";
        }

        if (event.type === 'mousedown' || event.type === 'mouseup') {
            var mask = 1 << event.button;
            if (down) {
                this.buttonMask |= mask;
            } else {
                this.buttonMask &= ~mask;
            }

            data["button"] = this.buttonMask;
        }

        data["x"] = this.x;
        data["y"] = this.y;

        this.send(JSON.stringify(data));
    }

    /**
     * Handles touch events and sends them to WebRTC app.
     * @param {TouchEvent} event
     */
    _touch(event) {
        var mask = 1;
        var data = {};

        if (event.type === 'touchstart') {
            this.buttonMask |= mask;
            data["event"] = "MouseButtonPress";
            data["button"] = this.buttonMask;
        } else if (event.type === 'touchend') {
            this.buttonMask &= ~mask;
            data["event"] = "MouseButtonRelease";
            data["button"] = this.buttonMask;
        } else if (event.type === 'touchmove') {
            event.preventDefault();
            data["event"] = "MouseMove";
        }

        this.x = this._clientToServerX(event.changedTouches[0].clientX);
        this.y = this._clientToServerY(event.changedTouches[0].clientY);

        data["x"] = this.x;
        data["y"] = this.y;

        this.send(JSON.stringify(data));
    }

    /**
     * Handles mouse wheel events and sends them to WebRTC app.
     * @param {MouseEvent} event
     */
    _wheel(event) {
        let data = {
            "event": "MouseScroll",
            "x": this.x,
            "y": this.y,
            "delta_x": -event.deltaX,
            "delta_y": -event.deltaY,
        };

        this.send(JSON.stringify(data));

        event.preventDefault();
    }

    /**
     * Captures mouse context menu (right-click) event and prevents event propagation.
     * @param {MouseEvent} event
     */
    _contextMenu(event) {
        event.preventDefault();
    }

    /**
     * Captures keyboard events to detect pressing of CTRL-SHIFT hotkey.
     * @param {KeyboardEvent} event
     */
    _key(event) {

        // disable problematic browser shortcuts
        if (event.code === 'F5' && event.ctrlKey ||
            event.code === 'KeyI' && event.ctrlKey && event.shiftKey ||
            event.code === 'F11') {
            event.preventDefault();
            return;
        }

        // capture menu hotkey
        if (event.type === 'keydown' && event.code === 'KeyM' && event.ctrlKey && event.shiftKey) {
            if (document.fullscreenElement === null && this.onmenuhotkey !== null) {
                this.onmenuhotkey();
                event.preventDefault();
            }

            return;
        }

        // capture fullscreen hotkey
        if (event.type === 'keydown' && event.code === 'KeyF' && event.ctrlKey && event.shiftKey) {
            if (document.fullscreenElement === null && this.onfullscreenhotkey !== null) {
                this.onfullscreenhotkey();
                event.preventDefault();
            }
            return;
        }
    }

    /**
     * Sends WebRTC app command to hide the remote pointer when exiting pointer lock.
     */
    _exitPointerLock() {
        document.exitPointerLock();
    }

    /**
     * Captures display and video dimensions required for computing mouse pointer position.
     * This should be fired whenever the window size changes.
     */
    _windowMath() {
        const windowW = this.element.offsetWidth;
        const windowH = this.element.offsetHeight;
        const frameW = this.element.videoWidth;
        const frameH = this.element.videoHeight;

        const multi = Math.min(windowW / frameW, windowH / frameH);
        const vpWidth = frameW * multi;
        const vpHeight = (frameH * multi);

        var elem = this.element;
        var offsetLeft = 0;
        var offsetTop = 0;
        do {
            if (!isNaN(elem.offsetLeft)) {
                offsetLeft += elem.offsetLeft;
            }

            if (!isNaN(elem.offsetTop)) {
                offsetTop += elem.offsetTop;
            }
        } while (elem = elem.offsetParent);

        this.m = {
            mouseMultiX: frameW / vpWidth,
            mouseMultiY: frameH / vpHeight,
            mouseOffsetX: Math.max((windowW - vpWidth) / 2.0, 0),
            mouseOffsetY: Math.max((windowH - vpHeight) / 2.0, 0),
            offsetLeft: offsetLeft,
            offsetTop: offsetTop,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            frameW,
            frameH,
        };
    }

    /**
     * Translates pointer position X based on current window math.
     * @param {Integer} clientX
     */
    _clientToServerX(clientX) {
        var serverX = Math.round((clientX - this.m.mouseOffsetX - this.m.offsetLeft + this.m.scrollX) * this.m.mouseMultiX);

        if (serverX === this.m.frameW - 1) serverX = this.m.frameW;
        if (serverX > this.m.frameW) serverX = this.m.frameW;
        if (serverX < 0) serverX = 0;

        return serverX;
    }

    /**
     * Translates pointer position Y based on current window math.
     * @param {Integer} clientY
     */
    _clientToServerY(clientY) {
        let serverY = Math.round((clientY - this.m.mouseOffsetY - this.m.offsetTop + this.m.scrollY) * this.m.mouseMultiY);

        if (serverY === this.m.frameH - 1) serverY = this.m.frameH;
        if (serverY > this.m.frameH) serverY = this.m.frameH;
        if (serverY < 0) serverY = 0;

        return serverY;
    }

    /**
     * When fullscreen is entered, request keyboard and pointer lock.
     */
    _onFullscreenChange() {
        if (document.fullscreenElement !== null) {
            // Enter fullscreen
            this.requestKeyboardLock();
            this.element.requestPointerLock();
        }
        // Reset local keyboard. When holding to exit full-screen the escape key can get stuck.
        this.keyboard.reset();

        // Reset stuck keys on server side.
        // FIXME: How to implement resetting keyboard with the GstNavigation interface
        // this.send("kr");
    }

    /**
     * Called when window is being resized, used to detect when resize ends so new resolution can be sent.
     */
    _resizeStart() {
        this._rtime = new Date();
        if (this._rtimeout === false) {
            this._rtimeout = true;
            setTimeout(() => { this._resizeEnd() }, this._rdelta);
        }
    }

    /**
     * Called in setTimeout loop to detect if window is done being resized.
     */
    _resizeEnd() {
        if (new Date() - this._rtime < this._rdelta) {
            setTimeout(() => { this._resizeEnd() }, this._rdelta);
        } else {
            this._rtimeout = false;
            if (this.onresizeend !== null) {
                this.onresizeend();
            }
        }
    }

    /**
     * Attaches input event handles to docuemnt, window and element.
     */
    attach() {
        this.listeners.push(addListener(this.element, 'resize', this._windowMath, this));
        this.listeners.push(addListener(this.element, 'wheel', this._wheel, this));
        this.listeners.push(addListener(this.element, 'contextmenu', this._contextMenu, this));
        this.listeners.push(addListener(this.element.parentElement, 'fullscreenchange', this._onFullscreenChange, this));
        this.listeners.push(addListener(window, 'keydown', this._key, this));
        this.listeners.push(addListener(window, 'keyup', this._key, this));
        this.listeners.push(addListener(window, 'resize', this._windowMath, this));
        this.listeners.push(addListener(window, 'resize', this._resizeStart, this));

        if ('ontouchstart' in window) {
            console.warning("FIXME: Enabling mouse pointer display for touch devices.");
        } else {
            this.listeners.push(addListener(this.element, 'mousemove', this._mouseButtonMovement, this));
            this.listeners.push(addListener(this.element, 'mousedown', this._mouseButtonMovement, this));
            this.listeners.push(addListener(this.element, 'mouseup', this._mouseButtonMovement, this));
        }

        // Adjust for scroll offset
        this.listeners.push(addListener(window, 'scroll', () => {
            this.m.scrollX = window.scrollX;
            this.m.scrollY = window.scrollY;
        }, this));

        // Using guacamole keyboard because it has the keysym translations.
        this.keyboard = new Keyboard(window);
        this.keyboard.onkeydown = (keysym) => {
            this.send(JSON.stringify( {"event": "KeyPress", "key": keysym}));
        };
        this.keyboard.onkeyup = (keysym) => {
            this.send(JSON.stringify( {"event": "KeyRelease", "key": keysym}));
        };

        this._windowMath();
    }

    detach() {
        removeListeners(this.listeners);
        this._exitPointerLock();
        if (this.keyboard) {
            this.keyboard.onkeydown = null;
            this.keyboard.onkeyup = null;
            this.keyboard.reset();
            delete this.keyboard;
            // FIXME: How to implement resetting keyboard with the GstNavigation interface
            // this.send("kr");
        }
    }

    /**
     * Request keyboard lock, must be in fullscreen mode to work.
     */
    requestKeyboardLock() {
        // event codes: https://www.w3.org/TR/uievents-code/#key-alphanumeric-writing-system
        const keys = [
            "AltLeft",
            "AltRight",
            "Tab",
            "Escape",
            "ContextMenu",
            "MetaLeft",
            "MetaRight"
        ];
        console.log("requesting keyboard lock");
        navigator.keyboard.lock(keys).then(
            () => {
                console.log("keyboard lock success");
            }
        ).catch(
            (e) => {
                console.log("keyboard lock failed: ", e);
            }
        )
    }

    getWindowResolution() {
        return [
            parseInt(this.element.offsetWidth * window.devicePixelRatio),
            parseInt(this.element.offsetHeight * window.devicePixelRatio)
        ];
    }
}

/**
 * Helper function to keep track of attached event listeners.
 * @param {Object} obj
 * @param {string} name
 * @param {function} func
 * @param {Object} ctx
 */
function addListener(obj, name, func, ctx) {
    const newFunc = ctx ? func.bind(ctx) : func;
    obj.addEventListener(name, newFunc);

    return [obj, name, newFunc];
}

/**
 * Helper function to remove all attached event listeners.
 * @param {Array} listeners
 */
function removeListeners(listeners) {
    for (const listener of listeners)
        listener[0].removeEventListener(listener[1], listener[2]);
}
