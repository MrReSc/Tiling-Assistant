'use strict';

const { Clutter, GLib, GObject, Meta } = imports.gi;
const { main: Main, windowManager: WindowManager } = imports.ui;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { Orientation, RestoreOn, MoveModes, Settings, Shortcuts } = Me.imports.src.common;
const { Rect, Util } = Me.imports.src.extension.utility;
const Twm = Me.imports.src.extension.tilingWindowManager.TilingWindowManager;

/**
 * This class gets to handle the move events (grab & monitor change) of windows.
 * If the moved window is tiled at the start of the grab, untile it. This is
 * done by releasing the grab via code, resizing the window, and then restarting
 * the grab via code. On Wayland this may not be reliable. As a workaround there
 * is a setting to restore a tiled window's size on the actual grab end.
 */

var Handler = class TilingMoveHandler {
    constructor() {
        const moveOps = [Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING];

        this._displaySignals = [];
        const g1Id = global.display.connect('grab-op-begin', (src, window, grabOp) => {
            if (window && moveOps.includes(grabOp))
                this._onMoveStarted(window, grabOp);
        });
        this._displaySignals.push(g1Id);

        const g2Id = global.display.connect('grab-op-end', (src, window, grabOp) => {
            if (window && moveOps.includes(grabOp))
                this._onMoveFinished(window);
        });
        this._displaySignals.push(g2Id);

        const wId = global.display.connect('window-entered-monitor', this._onMonitorEntered.bind(this));
        this._displaySignals.push(wId);

        // Save the windows, which need to make space for the
        // grabbed window (this is for the so called 'adaptive mode'):
        // { window1: newTileRect1, window2: newTileRect2, ... }
        this._splitRects = new Map();
        // The rect the grabbed window will tile to
        // (it may differ from the tilePreview's rect)
        this._tileRect = null;

        this._favoritePreviews = [];
        this._tilePreview = new TilePreview();
    }

    destroy() {
        this._displaySignals.forEach(sId => global.display.disconnect(sId));
        this._tilePreview.destroy();

        if (this._latestMonitorLockTimerId) {
            GLib.Source.remove(this._latestMonitorLockTimerId);
            this._latestMonitorLockTimerId = null;
        }

        if (this._latestPreviewTimerId) {
            GLib.Source.remove(this._latestPreviewTimerId);
            this._latestPreviewTimerId = null;
        }

        if (this._cursorChangeTimerId) {
            GLib.Source.remove(this._cursorChangeTimerId);
            this._cursorChangeTimerId = null;
        }

        if (this._restoreSizeTimerId) {
            GLib.Source.remove(this._restoreSizeTimerId);
            this._restoreSizeTimerId = null;
        }
    }

    _onMonitorEntered(src, monitorNr, window) {
        if (this._isGrabOp)
            // Reset preview mode:
            // Currently only needed to grab the favorite layout for the new monitor.
            this._preparePreviewModeChange(this._currPreviewMode, window);
    }

    _onMoveStarted(window, grabOp) {
        // Also work with a window, which was maximized by GNOME natively
        // because it may have been tiled with this extension before being
        // maximized so we need to restore its size to pre-tiling.
        this._wasMaximizedOnStart = window.get_maximized();
        const [eventX, eventY] = global.get_pointer();

        // Try to restore the window size
        const restoreSetting = Settings.getString(Settings.RESTORE_SIZE_ON);
        if ((window.tiledRect || this._wasMaximizedOnStart) &&
                restoreSetting === RestoreOn.ON_GRAB_START) {
            // HACK:
            // The grab begin signal (and thus this function call) gets fired
            // at the moment of the first click. However I don't want to restore
            // the window size on just a click. Only if the user actually wanted
            // to start a grab i.e. if the click is held for a bit or if the
            // cursor moved while holding the click. I assume a cursor change
            // means the grab was released since I couldn't find a better way...
            let grabReleased = false;
            let cursorId = global.display.connect('cursor-updated', () => {
                grabReleased = true;
                cursorId && global.display.disconnect(cursorId);
                cursorId = 0;
            });
            // Clean up in case my assumption mentioned above is wrong
            // and the cursor never gets updated or something else...
            this._cursorChangeTimerId && GLib.Source.remove(this._cursorChangeTimerId);
            this._cursorChangeTimerId = GLib.timeout_add(GLib.PRIORITY_LOW, 400, () => {
                cursorId && global.display.disconnect(cursorId);
                cursorId = 0;
                this._cursorChangeTimerId = null;
                return GLib.SOURCE_REMOVE;
            });

            let counter = 0;
            this._restoreSizeTimerId && GLib.Source.remove(this._restoreSizeTimerId);
            this._restoreSizeTimerId = GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE, 10, () => {
                if (grabReleased) {
                    this._restoreSizeTimerId = null;
                    return GLib.SOURCE_REMOVE;
                }

                counter += 10;
                if (counter >= 400) {
                    this._restoreSizeAndRestartGrab(window, eventX, eventY, grabOp);
                    this._restoreSizeTimerId = null;
                    return GLib.SOURCE_REMOVE;
                }

                const [currX, currY] = global.get_pointer();
                const currPoint = { x: currX, y: currY };
                const oldPoint = { x: eventX, y: eventY };
                const moveDist = Util.getDistance(currPoint, oldPoint);
                if (moveDist > 10) {
                    this._restoreSizeAndRestartGrab(window, eventX, eventY, grabOp);
                    this._restoreSizeTimerId = null;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });

        // Tile preview
        } else {
            this._isGrabOp = true;
            this._monitorNr = global.display.get_current_monitor();
            this._lastMonitorNr = this._monitorNr;

            const activeWs = global.workspace_manager.get_active_workspace();
            const monitor = global.display.get_current_monitor();
            const workArea = new Rect(activeWs.get_work_area_for_monitor(monitor));

            const topTileGroup = Twm.getTopTileGroup({ skipTopWindow: true });
            const tRects = topTileGroup.map(w => w.tiledRect);
            const freeScreenRects = workArea.minus(tRects);
            this._posChangedId = window.connect('position-changed',
                this._onMoving.bind(
                    this,
                    grabOp,
                    window,
                    topTileGroup,
                    freeScreenRects
                )
            );
        }
    }

    _onMoveFinished(window) {
        if (this._posChangedId) {
            window.disconnect(this._posChangedId);
            this._posChangedId = 0;
        }

        if (this._tileRect) {
            // Ctrl-drag to replace some windows in a tile group / create a new tile group
            // with at least 1 window being part of multiple tile groups.
            let isCtrlReplacement = false;
            const ctrlReplacedTileGroup = [];
            const topTileGroup = Twm.getTopTileGroup({ skipTopWindow: true });
            const pointerPos = { x: global.get_pointer()[0], y: global.get_pointer()[1] };
            const twHovered = topTileGroup.some(w => w.tiledRect.containsPoint(pointerPos));
            if (this._currPreviewMode === MoveModes.ADAPTIVE_TILING && !this._splitRects.size && twHovered) {
                isCtrlReplacement = true;
                ctrlReplacedTileGroup.push(window);
                topTileGroup.forEach(w => {
                    if (!this._tileRect.containsRect(w.tiledRect))
                        ctrlReplacedTileGroup.push(w);
                });
            }

            this._splitRects.forEach((rect, w) => Twm.tile(w, rect, { openTilingPopup: false }));
            this._splitRects.clear();
            Twm.tile(window, this._tileRect, { openTilingPopup: this._currPreviewMode !== MoveModes.ADAPTIVE_TILING });
            this._tileRect = null;

            // Create a new tile group, in which some windows are already part
            // of a different tile group, with ctrl-(super)-drag. The window may
            // be maximized by ctrl-super-drag.
            isCtrlReplacement && window.isTiled && Twm.updateTileGroup(ctrlReplacedTileGroup);
        } else {
            const restoreSetting = Settings.getString(Settings.RESTORE_SIZE_ON);
            const restoreOnEnd = restoreSetting === RestoreOn.ON_GRAB_END;
            restoreOnEnd && Twm.untile(
                window, {
                    restoreFullPos: false,
                    xAnchor: this._lastPointerPos.x,
                    skipAnim: this._wasMaximizedOnStart
                }
            );
        }

        this._favoriteLayout = [];
        this._favoritePreviews?.forEach(p => p.destroy());
        this._favoritePreviews = [];
        this._anchorRect = null;
        this._tilePreview.close();
        this._currPreviewMode = '';
        this._isGrabOp = false;
    }

    _onMoving(grabOp, window, topTileGroup, freeScreenRects) {
        // Use the current event's coords instead of global.get_pointer
        // to support touch...?
        const event = Clutter.get_current_event();
        if (!event)
            return;

        const [eventX, eventY] = grabOp === Meta.GrabOp.KEYBOARD_MOVING
            ? global.get_pointer()
            : event.get_coords();
        this._lastPointerPos = { x: eventX, y: eventY };

        const ctrl = Clutter.ModifierType.CONTROL_MASK;
        const altL = Clutter.ModifierType.MOD1_MASK;
        const altGr = Clutter.ModifierType.MOD5_MASK;
        const rmb = Clutter.ModifierType.BUTTON3_MASK;
        const pressed = {
            Ctrl: Util.isModPressed(ctrl),
            Alt: Util.isModPressed(altL) || Util.isModPressed(altGr),
            RMB: Util.isModPressed(rmb)
        };

        const defaultMode = Settings.getString(Settings.DEFAULT_MOVE_MODE);
        const splitActivator = Settings.getString(Settings.ADAPTIVE_TILING_MOD);
        const favActivator = Settings.getString(Settings.FAVORITE_LAYOUT_MOD);
        let newMode = '';

        if (pressed[splitActivator]) {
            newMode = defaultMode === MoveModes.ADAPTIVE_TILING
                ? MoveModes.EDGE_TILING
                : MoveModes.ADAPTIVE_TILING;
        } else if (pressed[favActivator]) {
            newMode = defaultMode === MoveModes.FAVORITE_LAYOUT
                ? MoveModes.EDGE_TILING
                : MoveModes.FAVORITE_LAYOUT;
        } else if (defaultMode === MoveModes.ADAPTIVE_TILING) {
            newMode = MoveModes.ADAPTIVE_TILING;
        } else if (defaultMode === MoveModes.FAVORITE_LAYOUT) {
            newMode = MoveModes.FAVORITE_LAYOUT;
        } else {
            newMode = MoveModes.EDGE_TILING;
        }

        if (this._currPreviewMode !== newMode)
            this._preparePreviewModeChange(newMode, window);

        switch (newMode) {
            case MoveModes.EDGE_TILING:
                this._edgeTilingPreview(window, grabOp);
                break;
            case MoveModes.ADAPTIVE_TILING:
                this._adaptiveTilingPreview(window, grabOp, topTileGroup, freeScreenRects);
                break;
            case MoveModes.FAVORITE_LAYOUT:
                this._favoriteLayoutTilingPreview(window);
        }

        this._currPreviewMode = newMode;
    }

    _preparePreviewModeChange(newMode, window) {
        // Cleanups / resets
        this._tileRect = null;
        this._splitRects.clear();
        this._favoritePreviews.forEach(p => {
            p.ease({
                opacity: 0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => p.destroy()
            });
        });
        this._favoritePreviews = [];
        this._anchorRect = null;

        switch (newMode) {
            case MoveModes.FAVORITE_LAYOUT:
                this._favoriteLayout = Util.getFavoriteLayout();
                this._favoriteLayout.forEach(rect => {
                    const tilePreview = new TilePreview();
                    tilePreview.open(window, rect, this._monitorNr, {
                        opacity: 255,
                        duration: 150
                    });
                    this._favoritePreviews.push(tilePreview);
                });
        }
    }

    _restoreSizeAndRestartGrab(window, eventX, eventY, grabOp) {
        global.display.end_grab_op(global.get_current_time());

        const rect = window.get_frame_rect();
        const x = eventX - rect.x;
        const relativeX = x / rect.width;
        let untiledRect = window.untiledRect;
        Twm.untile(window, {
            restoreFullPos: false,
            xAnchor: eventX,
            skipAnim: this._wasMaximizedOnStart
        });
        // untiledRect is null, if the window was maximized via non-extension
        // way (dblc-ing the titlebar, maximize button...). So just get the
        // restored window's rect directly... doesn't work on Wayland because
        // get_frame_rect() doesnt return the correct size immediately after
        // calling untile()... in that case just guess a random size
        if (!untiledRect && !Meta.is_wayland_compositor())
            untiledRect = new Rect(rect);

        const untiledWidth = untiledRect?.width ?? 1000;
        const postUntileRect = window.get_frame_rect();

        global.display.begin_grab_op(
            window,
            grabOp,
            true, // Pointer already grabbed
            true, // Frame action
            -1, // Button
            global.get_pointer()[2], // modifier
            global.get_current_time(),
            postUntileRect.x + untiledWidth * relativeX,
            // So the pointer isn't above the window in some cases.
            Math.max(eventY, postUntileRect.y)
        );
    }

    /**
     * Previews the rect the `window` will tile to when moving along the
     * screen edges.
     *
     * @param {Meta.Window} window the grabbed Meta.Window.
     * @param {Meta.GrabOp} grabOp the current Meta.GrabOp.
     */
    _edgeTilingPreview(window, grabOp) {
        // When switching monitors, provide a short grace period
        // in which the tile preview will stick to the old monitor so that
        // the user doesn't have to slowly inch the mouse to the monitor edge
        // just because there is another monitor at that edge.
        const currMonitorNr = global.display.get_current_monitor();
        if (this._lastMonitorNr !== currMonitorNr) {
            this._monitorNr = this._lastMonitorNr;
            let timerId = 0;
            this._latestMonitorLockTimerId && GLib.Source.remove(this._latestMonitorLockTimerId);
            this._latestMonitorLockTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                // Only update the monitorNr, if the latest timer timed out.
                if (timerId === this._latestMonitorLockTimerId) {
                    this._monitorNr = global.display.get_current_monitor();
                    if (global.display.get_grab_op() === grabOp) // !
                        this._edgeTilingPreview(window, grabOp);
                }

                this._latestMonitorLockTimerId = null;
                return GLib.SOURCE_REMOVE;
            });
            timerId = this._latestMonitorLockTimerId;
        }
        this._lastMonitorNr = currMonitorNr;

        const wRect = window.get_frame_rect();
        const workArea = new Rect(window.get_work_area_for_monitor(this._monitorNr));

        const vDetectionSize = Settings.getInt(Settings.VERTICAL_PREVIEW_AREA);
        const pointerAtTopEdge = this._lastPointerPos.y <= workArea.y + vDetectionSize;
        const pointerAtBottomEdge = this._lastPointerPos.y >= workArea.y2 - vDetectionSize;
        const hDetectionSize = Settings.getInt(Settings.HORIZONTAL_PREVIEW_AREA);
        const pointerAtLeftEdge = this._lastPointerPos.x <= workArea.x + hDetectionSize;
        const pointerAtRightEdge = this._lastPointerPos.x >= workArea.x2 - hDetectionSize;
        // Also use window's pos for top and bottom area detection for quarters
        // because global.get_pointer's y isn't accurate (no idea why...) when
        // grabbing the titlebar & slowly going from the left/right sides to
        // the top/bottom corners.
        const titleBarGrabbed = this._lastPointerPos.y - wRect.y < 50;
        const windowAtTopEdge = titleBarGrabbed && wRect.y === workArea.y;
        const windowAtBottomEdge = wRect.y >= workArea.y2 - 75;
        const tileTopLeftQuarter = pointerAtLeftEdge && (pointerAtTopEdge || windowAtTopEdge);
        const tileTopRightQuarter = pointerAtRightEdge && (pointerAtTopEdge || windowAtTopEdge);
        const tileBottomLeftQuarter = pointerAtLeftEdge && (pointerAtBottomEdge || windowAtBottomEdge);
        const tileBottomRightQuarter = pointerAtRightEdge && (pointerAtBottomEdge || windowAtBottomEdge);

        if (tileTopLeftQuarter) {
            this._tileRect = Twm.getTileFor(Shortcuts.TOP_LEFT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileTopRightQuarter) {
            this._tileRect = Twm.getTileFor(Shortcuts.TOP_RIGHT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileBottomLeftQuarter) {
            this._tileRect = Twm.getTileFor(Shortcuts.BOTTOM_LEFT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (tileBottomRightQuarter) {
            this._tileRect = Twm.getTileFor(Shortcuts.BOTTOM_RIGHT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtTopEdge) {
            // Switch between maximize & top tiling when keeping the mouse at the top edge.
            const monitorRect = global.display.get_monitor_geometry(this._monitorNr);
            const isLandscape = monitorRect.width >= monitorRect.height;
            const shouldMaximize =
                    isLandscape && !Settings.getBoolean(Settings.ENABLE_HOLD_INVERSE_LANDSCAPE) ||
                    !isLandscape && !Settings.getBoolean(Settings.ENABLE_HOLD_INVERSE_PORTRAIT);
            const tileRect = shouldMaximize
                ? workArea
                : Twm.getTileFor(Shortcuts.TOP, workArea, this._monitorNr);
            const holdTileRect = shouldMaximize
                ? Twm.getTileFor(Shortcuts.TOP, workArea, this._monitorNr)
                : workArea;
            // Dont open preview / start new timer if preview was already one for the top
            if (this._tilePreview._rect &&
                        (holdTileRect.equal(this._tilePreview._rect) ||
                                this._tilePreview._rect.equal(tileRect.meta)))
                return;

            this._tileRect = tileRect;
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);

            let timerId = 0;
            this._latestPreviewTimerId && GLib.Source.remove(this._latestPreviewTimerId);
            this._latestPreviewTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Settings.getInt(Settings.INVERSE_TOP_MAXIMIZE_TIMER), () => {
                // Only open the alternative preview, if the timeout-ed timer
                // is the same as the one which started last
                    if (timerId === this._latestPreviewTimerId &&
                        this._tilePreview._showing &&
                        this._tilePreview._rect.equal(tileRect.meta)) {
                        this._tileRect = holdTileRect;
                        this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
                    }

                    this._latestPreviewTimerId = null;
                    return GLib.SOURCE_REMOVE;
                });
            timerId = this._latestPreviewTimerId;
        } else if (pointerAtBottomEdge) {
            this._tileRect = Twm.getTileFor(Shortcuts.BOTTOM, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtLeftEdge) {
            this._tileRect = Twm.getTileFor(Shortcuts.LEFT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else if (pointerAtRightEdge) {
            this._tileRect = Twm.getTileFor(Shortcuts.RIGHT, workArea, this._monitorNr);
            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr);
        } else {
            this._tileRect = null;
            this._tilePreview.close();
        }
    }

    /**
     * Activates the secondary preview mode. By default, it's activated with
     * `Ctrl`. When tiling using this mode, it will not only affect the grabbed
     * window but possibly others as well. It's split into a 'single' and a
     * 'group' mode. Take a look at _adaptiveTilingPreviewSingle() and
     * _adaptiveTilingPreviewGroup() for details.
     *
     * @param {Meta.Window} window
     * @param {Meta.GrabOp} grabOp
     * @param {Meta.Window[]} topTileGroup
     * @param {Rect[]} freeScreenRects
     */
    _adaptiveTilingPreview(window, grabOp, topTileGroup, freeScreenRects) {
        if (!topTileGroup.length) {
            this._edgeTilingPreview(window, grabOp);
            return;
        }

        const screenRects = topTileGroup.map(w => w.tiledRect).concat(freeScreenRects);
        const hoveredRect = screenRects.find(r => r.containsPoint(this._lastPointerPos));
        if (!hoveredRect) {
            this._tilePreview.close();
            this._tileRect = null;
            return;
        }

        const isSuperPressed = Util.isModPressed(Clutter.ModifierType.MOD4_MASK);
        if (isSuperPressed) {
            this._anchorRect = this._anchorRect ?? hoveredRect;
            this._tileRect = hoveredRect.union(this._anchorRect);
            this._splitRects.clear();

            this._tilePreview.open(window, this._tileRect.meta, this._monitorNr, {
                x: this._tileRect.x,
                y: this._tileRect.y,
                width: this._tileRect.width,
                height: this._tileRect.height,
                opacity: 200
            });
        } else {
            this._anchorRect = null;
            const edgeRadius = 50;
            const atTopEdge = this._lastPointerPos.y < hoveredRect.y + edgeRadius;
            const atBottomEdge = this._lastPointerPos.y > hoveredRect.y2 - edgeRadius;
            const atLeftEdge = this._lastPointerPos.x < hoveredRect.x + edgeRadius;
            const atRightEdge = this._lastPointerPos.x > hoveredRect.x2 - edgeRadius;

            atTopEdge || atBottomEdge || atLeftEdge || atRightEdge
                ? this._adaptiveTilingPreviewGroup(window, hoveredRect, topTileGroup,
                    { atTopEdge, atBottomEdge, atLeftEdge, atRightEdge })
                : this._adaptiveTilingPreviewSingle(window, hoveredRect, topTileGroup);
        }
    }

    /**
     * In this mode, when moving a window over a tiled window, the tilePreview
     * will appear and (partly) cover the tiled window. If your pointer is at
     * the center, the grabbed window will just tile over the hovered tiled
     * window. If your pointer is hovering over the sides (but not the very
     * edges) of the tiled window, the tilePreview will only cover half of the
     * tiled window. Once the grabbed window is tiled, the previously hovered
     * tiled window, will make space for the grabbed window by halving its size.
     *
     * @param {Meta.Window} window
     * @param {Rect} hoveredRect
     * @param {Meta.Window[]} topTileGroup
     */
    _adaptiveTilingPreviewSingle(window, hoveredRect, topTileGroup) {
        const atTop = this._lastPointerPos.y < hoveredRect.y + hoveredRect.height * .25;
        const atBottom = this._lastPointerPos.y > hoveredRect.y + hoveredRect.height * .75;
        const atRight = this._lastPointerPos.x > hoveredRect.x + hoveredRect.width * .75;
        const atLeft = this._lastPointerPos.x < hoveredRect.x + hoveredRect.width * .25;
        const splitVertically = atTop || atBottom;
        const splitHorizontally = atLeft || atRight;

        if (splitHorizontally || splitVertically) {
            const idx = atTop && !atRight || atLeft ? 0 : 1;
            const size = splitHorizontally ? hoveredRect.width : hoveredRect.height;
            const orienation = splitHorizontally ? Orientation.V : Orientation.H;
            this._tileRect = hoveredRect.getUnitAt(idx, size / 2, orienation);
        } else {
            this._tileRect = hoveredRect.copy();
        }

        if (!this._tilePreview.needsUpdate(this._tileRect))
            return;

        const monitor = global.display.get_current_monitor();
        this._tilePreview.open(window, this._tileRect.meta, monitor);
        this._splitRects.clear();

        const hoveredWindow = topTileGroup.find(w => {
            return w.tiledRect.containsPoint(this._lastPointerPos);
        });

        if (!hoveredWindow)
            return;

        // Don't halve the window, if we compelety cover it i. e.
        // the user is hovering the tiled window at the center.
        if (hoveredWindow.tiledRect.equal(this._tileRect))
            return;

        const splitRect = hoveredWindow.tiledRect.minus(this._tileRect)[0];
        this._splitRects.set(hoveredWindow, splitRect);
    }

    /**
     * Similiar to _adaptiveTilingPreviewSingle(). But it's activated by hovering
     * the very edges of a tiled window. And instead of affecting just 1 window
     * it can possibly re-tile multiple windows. A tiled window will be affected,
     * if it aligns with the edge that is being hovered. It's probably easier
     * to understand, if you see it in action first rather than reading about it.
     *
     * @param {Meta.Window} window
     * @param {Rect} hoveredRect
     * @param {Meta.Window[]} topTileGroup
     * @param {object} hovered contains booleans at which position the
     *      `hoveredRect` is hovered.
     */
    _adaptiveTilingPreviewGroup(window, hoveredRect, topTileGroup, hovered) {
        // Find the smallest window that will be affected and use it to calcuate
        // the sizes of the preview. Determine the new tileRects for the rest
        // of the tileGroup via Rect.minus().
        const smallestWindow = topTileGroup.reduce((smallest, w) => {
            if (hovered.atTopEdge) {
                if (w.tiledRect.y === hoveredRect.y || w.tiledRect.y2 === hoveredRect.y)
                    return w.tiledRect.height < smallest.tiledRect.height ? w : smallest;
            } else if (hovered.atBottomEdge) {
                if (w.tiledRect.y === hoveredRect.y2 || w.tiledRect.y2 === hoveredRect.y2)
                    return w.tiledRect.height < smallest.tiledRect.height ? w : smallest;
            } else if (hovered.atLeftEdge) {
                if (w.tiledRect.x === hoveredRect.x || w.tiledRect.x2 === hoveredRect.x)
                    return w.tiledRect.width < smallest.tiledRect.width ? w : smallest;
            } else if (hovered.atRightEdge) {
                if (w.tiledRect.x === hoveredRect.x2 || w.tiledRect.x2 === hoveredRect.x2)
                    return w.tiledRect.width < smallest.tiledRect.width ? w : smallest;
            }

            return smallest;
        });

        const monitor = global.display.get_current_monitor();
        const workArea = new Rect(window.get_work_area_for_monitor(monitor));
        // This factor is used in combination with the smallestWindow to
        // determine the final size of the grabbed window. Use half of the size
        // factor, if we are at the screen edges. The cases for the bottom and
        // right screen edges are covered further down.
        const factor = hovered.atLeftEdge && hoveredRect.x === workArea.x ||
                hovered.atTopEdge && hoveredRect.y === workArea.y
            ? 1 / 3
            : 2 / 3;

        // The grabbed window will be horizontal. The horizontal size (x1 - x2)
        // is determined by the furthest left- and right-reaching windows that
        // align with the hovered rect. The vertical size (height) is a fraction
        // of the smallestWindow.
        if (hovered.atTopEdge || hovered.atBottomEdge) {
            const getX1X2 = alignsAt => {
                return topTileGroup.reduce((x1x2, w) => {
                    const currX = x1x2[0];
                    const currX2 = x1x2[1];
                    return alignsAt(w)
                        ? [Math.min(w.tiledRect.x, currX), Math.max(w.tiledRect.x2, currX2)]
                        : x1x2;
                }, [hoveredRect.x, hoveredRect.x2]);
            };
            const alignTopEdge = w => {
                return hoveredRect.y === w.tiledRect.y ||
                        hoveredRect.y === w.tiledRect.y2;
            };
            const alignBottomEdge = w => {
                return hoveredRect.y2 === w.tiledRect.y2 ||
                        hoveredRect.y2 === w.tiledRect.y;
            };

            const [x1, x2] = getX1X2(hovered.atTopEdge ? alignTopEdge : alignBottomEdge);
            const size = Math.ceil(smallestWindow.tiledRect.height * factor);
            // Keep within workArea bounds.
            const y = Math.max(workArea.y, Math.floor(hovered.atTopEdge
                ? hoveredRect.y - size / 2
                : hoveredRect.y2 - size / 2
            ));
            const height = Math.min(size, workArea.y2 - y);

            this._tileRect = new Rect(x1, y, x2 - x1, height);

        // The grabbed window will be vertical. The vertical size (y1 - y2) is
        // determined by the furthest top- and bottom-reaching windows that align
        // with the hovered rect. The horizontal size (width) is a fraction of
        // the smallestWindow.
        } else {
            const getY1Y2 = alignsAt => {
                return topTileGroup.reduce((y1y2, w) => {
                    const currY = y1y2[0];
                    const currY2 = y1y2[1];
                    return alignsAt(w)
                        ? [Math.min(w.tiledRect.y, currY), Math.max(w.tiledRect.y2, currY2)]
                        : y1y2;
                }, [hoveredRect.y, hoveredRect.y2]);
            };
            const alignLeftEdge = w => {
                return hoveredRect.x === w.tiledRect.x ||
                        hoveredRect.x === w.tiledRect.x2;
            };
            const alignRightEdge = w => {
                return hoveredRect.x2 === w.tiledRect.x2 ||
                        hoveredRect.x2 === w.tiledRect.x;
            };

            const [y1, y2] = getY1Y2(hovered.atLeftEdge ? alignLeftEdge : alignRightEdge);
            const size = Math.ceil(smallestWindow.tiledRect.width * factor);
            // Keep within workArea bounds.
            const x = Math.max(workArea.x, Math.floor(hovered.atLeftEdge
                ? hoveredRect.x - size / 2
                : hoveredRect.x2 - size / 2
            ));
            const width = Math.min(size, workArea.x2 - x);

            this._tileRect = new Rect(x, y1, width, y2 - y1);
        }

        this._tileRect.tryAlignWith(workArea);

        if (!this._tilePreview.needsUpdate(this._tileRect))
            return;

        this._tilePreview.open(window, this._tileRect.meta, monitor);
        this._splitRects.clear();

        topTileGroup.forEach(w => {
            const leftOver = w.tiledRect.minus(this._tileRect);
            const splitRect = leftOver[0];
            // w isn't an affected window.
            if (splitRect?.equal(this._tileRect) ?? true)
                return;

            this._splitRects.set(w, splitRect);
        });
    }

    _favoriteLayoutTilingPreview(window) {
        // Holding Super will make the window span multiple rects of the favorite
        // layout starting from the rect, which the user starting holding Super in.
        const isSuperPressed = Util.isModPressed(Clutter.ModifierType.MOD4_MASK);
        for (const rect of this._favoriteLayout) {
            if (rect.containsPoint(this._lastPointerPos)) {
                if (isSuperPressed) {
                    this._anchorRect = this._anchorRect ?? rect;
                    this._tileRect = rect.union(this._anchorRect);
                } else {
                    this._tileRect = rect.copy();
                    this._anchorRect = null;
                }

                this._tilePreview.open(window, this._tileRect.meta, this._monitorNr, {
                    x: this._tileRect.x,
                    y: this._tileRect.y,
                    width: this._tileRect.width,
                    height: this._tileRect.height,
                    opacity: 200
                });
                return;
            }
        }

        this._tileRect = null;
        this._tilePreview.close();
    }
};

const TilePreview = GObject.registerClass(
class TilePreview extends WindowManager.TilePreview {
    _init() {
        super._init();
        this.set_style_class_name('tile-preview');
    }

    needsUpdate(rect) {
        return !this._rect || !rect.equal(this._rect);
    }

    // Added param for animation and removed style for rounded corners
    open(window, tileRect, monitorIndex, animateTo = undefined) {
        const windowActor = window.get_compositor_private();
        if (!windowActor)
            return;

        global.window_group.set_child_below_sibling(this, windowActor);

        if (this._rect && this._rect.equal(tileRect))
            return;

        const changeMonitor = this._monitorIndex === -1 ||
            this._monitorIndex !== monitorIndex;

        this._monitorIndex = monitorIndex;
        this._rect = tileRect;

        const monitor = Main.layoutManager.monitors[monitorIndex];

        if (!this._showing || changeMonitor) {
            const monitorRect = new Meta.Rectangle({
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height
            });
            const [, rect] = window.get_frame_rect().intersect(monitorRect);
            this.set_size(rect.width, rect.height);
            this.set_position(rect.x, rect.y);
            this.opacity = 0;
        }

        this._showing = true;
        this.show();

        if (!animateTo) {
            animateTo = {
                x: tileRect.x,
                y: tileRect.y,
                width: tileRect.width,
                height: tileRect.height,
                opacity: 255,
                duration: WindowManager.WINDOW_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            };
        } else {
            animateTo.x === undefined && this.set_x(tileRect.x);
            animateTo.y === undefined && this.set_y(tileRect.y);
            animateTo.width === undefined && this.set_width(tileRect.width);
            animateTo.height === undefined && this.set_height(tileRect.height);
            animateTo.opacity === undefined && this.set_opacity(255);
            animateTo.duration = animateTo.duration ?? WindowManager.WINDOW_ANIMATION_TIME;
            animateTo.mode = animateTo.mode ?? Clutter.AnimationMode.EASE_OUT_QUAD;
        }

        this.ease(animateTo);
    }
});
