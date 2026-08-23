// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Puffy Slippers Tech LLC

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GnomeBluetooth from 'gi://GnomeBluetooth?version=3.0';
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

        this._device.bind_property('icon', this._icon, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE);
        this._device.bind_property('alias', this._label, 'text',
            GObject.BindingFlags.SYNC_CREATE);

        this.connect('activate', () => this._toggle._selectDevice(this._device));

        this._sync();
    }

    _sync() {
        const pending = this._toggle._pendingPath === this._device.get_object_path();

        this.setOrnament(this._toggle._isDefaultDevice(this._device)
            ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);

        if (pending) {
            this._spinner.play();
            this._state.text = this._toggle._pendingConnect
                ? _('Connecting…') : _('Disconnecting…');
        } else {
            this._spinner.stop();
            this._state.text = this._device.connected
                ? _('Connected') : _('Connect');
        }
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
        this._deviceSignals = new Map();
        this._signals = [];
        this._defaultDeviceObj = null;
        this._pendingPath = null;
        this._pendingConnect = false;
        this._cancellable = null;

        this.menu.setHeader('bluetooth-active-symbolic', _('Bluetooth'));

        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);

        this._placeholderItem = new PopupMenu.PopupMenuItem(_('No paired devices'), {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._placeholderItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_('Bluetooth Settings'),
            'gnome-bluetooth-panel.desktop');

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

    _defaultDevice(devices) {
        if (devices.length === 0)
            return null;

        const saved = this._settings.get_string('default-address');
        return devices.find(device => device.address === saved) ?? devices[0];
    }

    _isDefaultDevice(device) {
        return this._defaultDeviceObj?.get_object_path() === device.get_object_path();
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
        const devices = this._pairedDevices();
        const device = this._defaultDevice(devices);
        this._defaultDeviceObj = device;

        const connected = device?.connected ?? false;
        this.checked = connected;
        this.icon_name = connected
            ? 'bluetooth-active-symbolic'
            : 'bluetooth-disabled-symbolic';

        if (this._pendingPath) {
            const pendingDevice = this._findByPath(this._pendingPath);
            if (pendingDevice) {
                this.title = pendingDevice.alias;
                this.subtitle = this._pendingConnect
                    ? _('Connecting…') : _('Disconnecting…');
            }
        } else if (device) {
            this.title = device.alias;
            this.subtitle = connected ? _('Connected') : _('Disconnected');
        } else {
            this.title = _('Bluetooth');
            this.subtitle = _('No paired devices');
        }

        this._updateDeviceItems(devices);
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
            this._deviceSection.addMenuItem(item);
            this._deviceItems.set(path, item);
        }

        this._deviceSection.actor.visible = this._deviceItems.size > 0;
        this._placeholderItem.visible = this._deviceItems.size === 0;

        for (const item of this._deviceItems.values())
            item._sync();
    }

    _selectDevice(device) {
        if (this._settings.get_string('default-address') !== device.address)
            this._settings.set_string('default-address', device.address);
        this._toggleDevice(device);
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
