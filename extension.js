// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Puffy Slippers Tech LLC

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GnomeBluetooth from 'gi://GnomeBluetooth?version=3.0';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

Gio._promisify(GnomeBluetooth.Client.prototype, 'connect_service');

const DeviceItem = GObject.registerClass(
class DeviceItem extends PopupMenu.PopupBaseMenuItem {
    _init(device, toggle) {
        super._init({style_class: 'bt-device-item'});

        this._device = device;
        this._toggle = toggle;

        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this.add_child(this._icon);

        this._label = new St.Label({x_expand: true});
        this.add_child(this._label);

        this._state = new St.Label({style_class: 'device-subtitle'});
        this.add_child(this._state);

        this._spinner = new Spinner(16, {hideOnStop: true});
        this.add_child(this._spinner);

        this._spinner.bind_property('visible',
            this._state, 'visible',
            GObject.BindingFlags.SYNC_CREATE |
            GObject.BindingFlags.INVERT_BOOLEAN);

        this._device.bind_property('connectable',
            this, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this._device.bind_property('icon',
            this._icon, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE);
        this._device.bind_property('alias',
            this._label, 'text',
            GObject.BindingFlags.SYNC_CREATE);
        this._device.bind_property_full('connected',
            this._state, 'text',
            GObject.BindingFlags.SYNC_CREATE,
            (bind, source) => [true, source ? _('Disconnect') : _('Connect')],
            null);

        this.connect('activate', () => this._toggle._selectDevice(this._device));
        this._device.connectObject(
            'notify::alias', () => this._updateAccessibleName(),
            'notify::connected', () => this._updateAccessibleName(),
            this);
        this._updateAccessibleName();
    }

    _updateAccessibleName() {
        this.accessible_name = this._device.connected
            // Translators: %s is a device name like "MyPhone"
            ? _('Disconnect %s').format(this._device.alias)
            // Translators: %s is a device name like "MyPhone"
            : _('Connect to %s').format(this._device.alias);
    }

    _sync() {
        const pending = this._toggle._pendingPath === this._device.get_object_path();

        if (pending)
            this._spinner.play();
        else
            this._spinner.stop();
    }
});

const PinnedDeviceItem = GObject.registerClass(
class PinnedDeviceItem extends PopupMenu.PopupBaseMenuItem {
    _init(device, selected, toggle) {
        super._init({style_class: 'bt-device-item'});

        this._device = device;
        this._toggle = toggle;

        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this.add_child(this._icon);

        this._label = new St.Label({x_expand: true});
        this.add_child(this._label);

        this._selectedIcon = new St.Icon({
            style_class: 'popup-menu-icon',
            icon_name: 'object-select-symbolic',
            visible: selected,
        });
        this.add_child(this._selectedIcon);

        this._device.bind_property('icon',
            this._icon, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE);
        this._device.bind_property('alias',
            this._label, 'text',
            GObject.BindingFlags.SYNC_CREATE);

        this.accessible_name = this._device.alias;
    }

    setSelected(selected) {
        this._selectedIcon.visible = selected;
    }

    activate(event) {
        this._toggle._selectPinnedDevice(this._device);
    }
});

const DefaultBluetoothToggle = GObject.registerClass(
class DefaultBluetoothToggle extends QuickSettings.QuickMenuToggle {
    _init(client, settings) {
        super._init({
            title: _('Bluetooth'),
            subtitle: _('Disconnected'),
            icon_name: 'bluetooth-disabled-symbolic',
            menu_button_accessible_name: _('Open Bluetooth menu'),
        });

        this._client = client;
        this._settings = settings;
        this._deviceItems = new Map();
        this._pinnedDeviceItems = new Map();
        this._deviceSignals = new Map();
        this._signals = [];
        this._defaultDeviceObj = null;
        this._pendingPath = null;
        this._pendingConnect = false;
        this._cancellable = null;

        this._toggleButton = this._box.get_first_child();

        this.menu.setHeader('bluetooth-active-symbolic', _('Bluetooth'));

        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);

        this._placeholderItem = new PopupMenu.PopupMenuItem(
            _('No available or connected devices'), {
                style_class: 'bt-menu-placeholder',
                reactive: false,
                can_focus: false,
            });
        this._placeholderItem.label.clutter_text.set({
            ellipsize: Pango.EllipsizeMode.NONE,
            line_wrap: true,
        });
        this.menu.addMenuItem(this._placeholderItem);

        this._deviceSection.actor.bind_property('visible',
            this._placeholderItem, 'visible',
            GObject.BindingFlags.SYNC_CREATE |
            GObject.BindingFlags.INVERT_BOOLEAN);

        this.menu.connect('open-state-changed', isOpen => {
            // Don't reorder the list while the menu is open,
            // so do it now to start with the proper order
            if (isOpen)
                this._reorderDeviceItems();
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_('Bluetooth Settings'),
            'gnome-bluetooth-panel.desktop');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const quickConnectOptionItem = new PopupMenu.PopupMenuItem(
            _('Quick Connect Option:'), {
                reactive: true,
                activate: false,
                hover: false,
                can_focus: false,
            });
        quickConnectOptionItem.track_hover = false;
        this.menu.addMenuItem(quickConnectOptionItem);

        this._lastUsedItem = new PopupMenu.PopupMenuItem(_('Last connected device'));
        this._lastUsedItem.connect('activate',
            () => this._setQuickConnectOption('last-used'));
        this.menu.addMenuItem(this._lastUsedItem);

        this._pinnedItem = new PopupMenu.PopupSubMenuMenuItem(_('Pinned device'));
        this._pinnedItem.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._setQuickConnectOption('pinned');
        });
        this.menu.addMenuItem(this._pinnedItem);

        this._pinnedPlaceholderItem = new PopupMenu.PopupMenuItem(
            _('No paired devices'), {
                reactive: false,
                can_focus: false,
            });
        this._pinnedItem.menu.addMenuItem(this._pinnedPlaceholderItem);

        this._signals.push([
            this._client,
            this._client.connect('device-added', (client, device) => {
                this._connectDeviceNotify(device);
                this._sync();
            }),
        ]);
        this._signals.push([
            this._client,
            this._client.connect('device-removed', (client, path) => {
                this._disconnectDeviceNotify(path);
                this._sync();
            }),
        ]);
        this._signals.push([
            this._settings,
            this._settings.connect('changed::default-address', () => this._sync()),
        ]);
        this._signals.push([
            this._settings,
            this._settings.connect('changed::quick-connect-option', () => this._sync()),
        ]);
        this._signals.push([
            this._settings,
            this._settings.connect('changed::pinned-address', () => this._sync()),
        ]);

        this.connect('clicked', () => this._toggleDefault());

        const store = this._client.get_devices();
        for (let i = 0; i < store.get_n_items(); i++)
            this._connectDeviceNotify(store.get_item(i));

        this._sync();
    }

    _pairedDevices() {
        const devices = [];
        const store = this._client.get_devices();
        for (let i = 0; i < store.get_n_items(); i++) {
            const device = store.get_item(i);
            if (device.paired || device.trusted)
                devices.push(device);
        }
        return devices;
    }

    _lastUsedDevice(devices) {
        if (devices.length === 0)
            return null;

        const saved = this._settings.get_string('default-address');
        return devices.find(device => device.address === saved) ?? devices[0];
    }

    _pinnedDevice(devices) {
        if (devices.length === 0)
            return null;

        const saved = this._settings.get_string('pinned-address');
        return devices.find(device => device.address === saved) ?? devices[0];
    }

    _defaultDevice(devices) {
        return this._settings.get_string('quick-connect-option') === 'pinned'
            ? this._pinnedDevice(devices)
            : this._lastUsedDevice(devices);
    }

    _getSortedDevices(devices) {
        return devices.sort((dev1, dev2) => {
            if (dev1.connected !== dev2.connected)
                return dev2.connected - dev1.connected;
            return dev1.alias.localeCompare(dev2.alias);
        });
    }

    _sortedPairedDevices() {
        return this._getSortedDevices(this._pairedDevices());
    }

    _findByPath(path) {
        const store = this._client.get_devices();
        for (let i = 0; i < store.get_n_items(); i++) {
            const device = store.get_item(i);
            if (device.get_object_path() === path)
                return device;
        }
        return null;
    }

    _connectDeviceNotify(device) {
        const path = device.get_object_path();
        if (this._deviceSignals.has(path))
            return;

        const id = device.connect('notify', (dev, pspec) => {
            if (pspec.name === 'connected' && dev.connected)
                this._updateLastUsed(dev);

            if (['connected', 'alias', 'paired', 'trusted'].includes(pspec.name))
                this._sync();
        });
        this._deviceSignals.set(path, [device, id]);
    }

    _disconnectDeviceNotify(path) {
        const entry = this._deviceSignals.get(path);
        if (!entry)
            return;

        entry[0].disconnect(entry[1]);
        this._deviceSignals.delete(path);
    }

    _sync() {
        const devices = this._sortedPairedDevices();
        const device = this._defaultDevice(devices);
        this._defaultDeviceObj = device;

        const connected = device?.connected ?? false;
        this.checked = connected;
        this.icon_name = connected
            ? 'bluetooth-active-symbolic'
            : 'bluetooth-disabled-symbolic';

        this._toggleButton.reactive = devices.length > 0;
        this._toggleButton.can_focus = devices.length > 0;

        const pendingDevice = this._pendingPath
            ? this._findByPath(this._pendingPath)
            : null;
        const pendingIsDefault = pendingDevice && device &&
            pendingDevice.get_object_path() === device.get_object_path();

        if (pendingIsDefault) {
            this.title = pendingDevice.alias;
            this.subtitle = this._pendingConnect
                ? _('Connecting…') : _('Disconnecting…');
        } else if (device) {
            this.title = device.alias;
            this.subtitle = connected ? _('Connected') : _('Disconnected');
        } else {
            this.title = _('No Devices');
            this.subtitle = null;
        }

        this._updateDeviceItems(devices);
        this._syncQuickConnectMenu(devices);
    }

    _updateDeviceItems(devices) {
        const paths = new Set(devices.map(device => device.get_object_path()));

        for (const [path, item] of this._deviceItems) {
            if (!paths.has(path)) {
                item.destroy();
                this._deviceItems.delete(path);
            }
        }

        for (const device of devices) {
            const path = device.get_object_path();
            if (this._deviceItems.has(path))
                continue;

            const item = new DeviceItem(device, this);
            item.connect('notify::visible', () => this._updateDeviceVisibility());
            this._deviceSection.addMenuItem(item);
            this._deviceItems.set(path, item);
        }

        this._updateDeviceVisibility();

        for (const item of this._deviceItems.values())
            item._sync();
    }

    _updateDeviceVisibility() {
        this._deviceSection.actor.visible =
            [...this._deviceItems.values()].some(item => item.visible);
    }

    _reorderDeviceItems() {
        const devices = this._sortedPairedDevices();
        for (const [i, device] of devices.entries()) {
            const item = this._deviceItems.get(device.get_object_path());
            if (!item)
                continue;

            this._deviceSection.moveMenuItem(item, i);
        }
    }

    _updateLastUsed(device) {
        if (this._settings.get_string('quick-connect-option') !== 'last-used')
            return;

        if (this._settings.get_string('default-address') !== device.address)
            this._settings.set_string('default-address', device.address);
    }

    _selectDevice(device) {
        if (this._settings.get_string('default-address') !== device.address)
            this._settings.set_string('default-address', device.address);
        this._toggleDevice(device);
    }

    _setQuickConnectOption(option) {
        if (this._settings.get_string('quick-connect-option') !== option)
            this._settings.set_string('quick-connect-option', option);
    }

    _setPinnedDevice(device) {
        if (this._settings.get_string('pinned-address') !== device.address)
            this._settings.set_string('pinned-address', device.address);
        this._setQuickConnectOption('pinned');
    }

    _selectPinnedDevice(device) {
        this._setPinnedDevice(device);
        this._pinnedItem.setSubmenuShown(false);
    }

    _syncQuickConnectMenu(devices) {
        const pinned = this._settings.get_string('quick-connect-option') === 'pinned';

        this._lastUsedItem.setOrnament(pinned
            ? PopupMenu.Ornament.NO_DOT
            : PopupMenu.Ornament.DOT);
        this._pinnedItem.setOrnament(pinned
            ? PopupMenu.Ornament.DOT
            : PopupMenu.Ornament.NO_DOT);

        const pinnedAddress = this._pinnedDevice(devices)?.address ?? null;
        const submenu = this._pinnedItem.menu;

        this._pinnedPlaceholderItem.visible = devices.length === 0;

        const paths = new Set(devices.map(device => device.get_object_path()));
        for (const [path, item] of this._pinnedDeviceItems) {
            if (!paths.has(path)) {
                item.destroy();
                this._pinnedDeviceItems.delete(path);
            }
        }

        for (const device of devices) {
            const path = device.get_object_path();
            const selected = device.address === pinnedAddress;

            if (this._pinnedDeviceItems.has(path)) {
                this._pinnedDeviceItems.get(path).setSelected(selected);
                continue;
            }

            const item = new PinnedDeviceItem(device, selected, this);
            submenu.addMenuItem(item);
            this._pinnedDeviceItems.set(path, item);
        }

        for (const [i, device] of devices.entries()) {
            const item = this._pinnedDeviceItems.get(device.get_object_path());
            if (!item)
                continue;

            submenu.moveMenuItem(item, i + 1);
        }
    }

    _toggleDefault() {
        if (this._defaultDeviceObj)
            this._toggleDevice(this._defaultDeviceObj);
    }

    async _toggleDevice(device) {
        if (this._pendingPath)
            return;

        const connect = !device.connected;
        this._pendingPath = device.get_object_path();
        this._pendingConnect = connect;
        this._sync();

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        try {
            await this._client.connect_service(
                device.get_object_path(), connect, cancellable);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                Main.notifyError(
                    connect
                        ? _('Bluetooth connect failed')
                        : _('Bluetooth disconnect failed'),
                    error.message);
            }
        } finally {
            if (!cancellable.is_cancelled()) {
                this._pendingPath = null;
                this._pendingConnect = false;
                this._sync();
            }
        }
    }

    destroy() {
        this._cancellable?.cancel();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        for (const [device, id] of this._deviceSignals.values())
            device.disconnect(id);
        this._signals = [];
        this._deviceSignals.clear();
        super.destroy();
    }
});

const DefaultBluetoothIndicator = GObject.registerClass(
class DefaultBluetoothIndicator extends QuickSettings.SystemIndicator {
    _init(client, settings) {
        super._init();
        this.quickSettingsItems.push(new DefaultBluetoothToggle(client, settings));
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class DefaultBluetoothExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._client = new GnomeBluetooth.Client();
        this._indicator = new DefaultBluetoothIndicator(
            this._client, this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._client = null;
        this._settings = null;
    }
}
