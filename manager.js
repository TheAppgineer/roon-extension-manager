// Copyright 2017 - 2021 The Appgineer
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

var RoonApi               = require("node-roon-api"),
    RoonApiSettings       = require('node-roon-api-settings'),
    RoonApiStatus         = require('node-roon-api-status'),
    ApiTimeInput          = require('node-api-time-input'),
    ApiExtensionInstaller = require('./installer-lib');

const GLOBAL_LOGS      = 1;

const ACTION_NO_CHANGE = 0;

const PORT = 2507;

var pending_actions = {};
var category_list = [];
var extension_list = [];
var action_list = [];
var timeout_id = null;
var ping_timer_id = null;
var watchdog_timer_id = null;
var last_message;
var last_is_error;

var roon = new RoonApi({
    extension_id:        'com.theappgineer.extension-manager',
    display_name:        "Roon Extension Manager",
    display_version:     "1.1.0",
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             `http://${get_ip()}:${PORT}/extension-logs.tar.gz`,

    core_found: function(core) {
        console.log('Core found:', core.display_name);
        clear_watchdog_timer();
        setup_ping_timer();
    },
    core_lost: function(core) {
        console.log('Core lost:', core.display_name);
        clear_ping_timer();
        setup_watchdog_timer();
    }
});

var ext_settings = roon.load_config("settings") || {
    update_time: "02:00"
};

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        pending_actions = {};           // Start off with a clean list

        get_settings_data(ext_settings, () => {
            cb(makelayout(ext_settings));
        });
    },
    save_settings: function(req, isdryrun, settings) {
        update_pending_actions(settings.values, () => {
            let l = makelayout(settings.values);
            req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

            if (!isdryrun && !l.has_error) {
                remove_docker_options(l.values);
                ext_settings = l.values;
                svc_settings.update_settings(l);
                roon.save_config("settings", ext_settings);

                set_update_timer();
                perform_pending_actions();

                if (installer.is_idle()) {
                    installer.set_on_activity_changed();
                } else {
                    installer.set_on_activity_changed(() => {
                        installer.set_on_activity_changed();
                    });
                }
            }
        });
    }
});

var svc_status = new RoonApiStatus(roon);
var timer = new ApiTimeInput();

var installer = new ApiExtensionInstaller({
    started: function() {
        roon.start_discovery();
    },
    repository_changed: function(values) {
        category_list = values;
    },
    status_changed: function(message, is_error) {
        set_status(message, is_error);
    }
}, process.argv[2]);

roon.init_services({
    provided_services: [ svc_settings, svc_status ]
});

function makelayout(settings) {
    let l = {
        values:    settings,
        layout:    [],
        has_error: false
    };
    let update = {
        type:    "string",
        title:   "Check for Updates",
        subtitle:"hh:mm[am|pm]",
        setting: "update_time"
    };
    let category = {
        type:    "dropdown",
        title:   "Category",
        values:  [{ title: "(select category)", value: undefined }],
        setting: "selected_category"
    };
    let selector = {
        type:    "dropdown",
        title:   "Extension",
        values:  [{ title: "(select extension)", value: undefined }],
        setting: "selected_extension"
    };
    let extension = {
        type:    "group",
        title:   "(no extension selected)",
        items:   []
    };
    let status_string = {
        type:    "label"
    };
    let action = {
        type:    "dropdown",
        title:   "Action",
        values:  [{ title: "(select action)", value: undefined }],
        setting: "action"
    };

    const features = installer.get_features();

    installer.set_on_activity_changed(() => {
        svc_settings.update_settings(l);
    });

    if (settings.update_time) {
        let valid_time = timer.validate_time_string(settings.update_time);

        if (valid_time) {
            settings.update_time = valid_time.friendly;
        } else {
            update.error = "Time should conform to format: hh:mm[am|pm]";
            l.has_error = true;
        }
    }

    const category_index = settings.selected_category;
    category.values = category.values.concat(category_list);

    if (category_index !== undefined && category_index < category_list.length) {
        extension_list = installer.get_extensions_by_category(category_index);
        selector.values = selector.values.concat(extension_list);
        selector.title = category_list[category_index].title + ' Extension';

        let name = undefined;

        for (let i = 0; i < extension_list.length; i++) {
            if (extension_list[i].value == settings.selected_extension) {
                name = settings.selected_extension;
                break;
            }
        }

        if (name !== undefined) {
            const status  = installer.get_status(name);
            const details = installer.get_details(name);
            let author = {
                type: "label"
            };

            if (details.packager) {
                author.title  = "Developed by: " + details.author;
                author.title += "\nPackaged by:   " + details.packager;
            } else {
                author.title = "by: " + details.author;
            }
            author.title += `\nPulls: ${get_rounded_pull_count(details.pull_count)}`;

            if (details.description) {
                extension.title = details.description;
            } else {
                extension.title = "(no description)";
            }

            status_string.title  = status.state.toUpperCase();
            status_string.title += (status.version ? ": version " + status.version : "");
            status_string.title += (status.tag ? ": tag " + status.tag : "");

            if (status.startup) {
                status_string.title += `\nUptime: ${get_up_time(status.startup)}`;
            }

            if (installer.is_idle(name)) {
                if (is_pending(name)) {
                    action_list = [{ title: 'Revert Action', value: ACTION_NO_CHANGE }];
                } else {
                    action_list = installer.get_actions(name);
                }

                action.values = action.values.concat(action_list);
            } else {
                action.values[0].title = '(in progress...)';
            }

            extension.items.push(author);
            extension.items.push(status_string);
            extension.items.push(action);

            const pending_action = (pending_actions[name] ? pending_actions[name].action : undefined);
            const options = installer.get_extension_options(name, pending_action);

            if (options) {
                extension.items = extension.items.concat(create_option_items(options, settings));
            }
        } else {
            settings.selected_extension = undefined;
        }
    } else {
        settings.selected_category = undefined;
        settings.selected_extension = undefined;
    }

    if (!features || features.auto_update != 'off') {
        l.layout.push(update);
    }

    l.layout.push({
        type:    "dropdown",
        title:   "Global Action",
        values:  [
            { title: "(select action)", value: undefined   },
            { title: "Collect Logs",    value: GLOBAL_LOGS }
        ],
        setting: "global_action"
    });

    l.layout.push({
        type:  "group",
        title: `[EXTENSION REPOSITORY v${settings.repo_version}]`,
        items: [category, selector, extension]
    });

    l.layout.push({
        type:    "group",
        title:   "[PENDING ACTIONS]",
        items:   [{
            type : "label",
            title: get_pending_actions_string()
        }]
    });

    return l;
}

function get_rounded_pull_count(pull_count) {
    let divider = 1;
    let digit = 0;

    while (pull_count / divider > 999) {
        digit++;
        divider *= 10;
    }

    const rounded_pull_count = `${Math.round(pull_count / divider)}`;
    let result;

    if (digit % 3) {
        const before_dot = rounded_pull_count.slice(0, digit % 3);
        const after_dot = rounded_pull_count.slice(digit % 3);

        result = `${before_dot}.${after_dot}`;
    } else {
        result = rounded_pull_count;
    }

    switch (digit) {
        case 0: //  xxx
            break;
        case 1: // x.xxk
        case 2: // xx.xk
        case 3: //  xxxk
            result += 'k';
            break;
        case 4: // x.xxM
        case 5: // xx.xM
        case 6: //  xxxM
            result += 'M';
            break;
        default:
            result = `${pull_count}`.slice(0, -6) + 'M';
            break
    }

    return result;
}

function get_up_time(startup_time) {
    const start = new Date(startup_time).getTime();
    let diff = Math.floor((Date.now() - start) / 1000);     // seconds
    let unit;

    if (diff < 60) {
        unit = (diff == 1 ? 'second' : 'seconds')
        return `${diff} ${unit}`;
    }

    diff = Math.floor(diff / 60);                           // minutes

    if (diff < 60) {
        unit = (diff == 1 ? 'minute' : 'minutes')
        return `${diff} ${unit}`;
    }

    diff = Math.floor(diff / 60);                           // hours

    if (diff < 24) {
        unit = (diff == 1 ? 'hour' : 'hours')
        return `${diff} ${unit}`;
    }

    diff = Math.floor(diff / 24);                           // days

    if (diff < 7) {
        unit = (diff == 1 ? 'day' : 'days')
        return `${diff} ${unit}`;
    }

    if (diff < 30) {
        diff = Math.floor(diff / 7);                        // weeks

        unit = (diff = 1 ? 'week' : 'weeks')
        return `${diff} ${unit}`;
    }

    if (diff < 365) {
        diff = Math.floor(diff / 30);                       // months

        unit = (diff == 1 ? 'month' : 'months')
        return `${diff} ${unit}`;
    }

    diff = Math.floor(diff / 365);                          // years

    unit = (diff == 1 ? 'year' : 'years')
    return `${diff} ${unit}`;
}

function create_option_items(options, settings) {
    let items = [];

    if (options.env) {
        for (const var_name in options.env) {
            const split = options.env[var_name].split(':');
            const setting_key = `docker_${settings.selected_extension}_env_${var_name}`;
            let env = {
                type:    'string',
                title:   split[1],
                setting: setting_key
            };

            if (split[0]) {
                env.subtitle = `default: ${split[0]}`;
            }

            if (!settings[setting_key]) {
                if (process.env[var_name]) {
                    settings[setting_key] = process.env[var_name];
                } else if (split[0]) {
                    settings[setting_key] = split[0];
                }
            }

            items.push(env);
        }
    }
    if (options.devices) {
        for (let i = 0; i < options.devices.length; i++) {
            const split = options.devices[i].split(':');
            const setting_key = `docker_${settings.selected_extension}_devices_${split[0] == '' ? i : split[0]}`;
            let device = {
                type:    'string',
                title:   split[1],
                setting: setting_key
            };

            if (split[0]) {
                device.subtitle = `default: ${split[0]}`;

                if (!settings[setting_key]) {
                    settings[setting_key] = split[0];
                }
            }

            items.push(device);
        }
    }
    if (options.binds) {
        for (let i = 0; i < options.binds.length; i++) {
            const split = options.binds[i].split(':');
            const setting_key = `docker_${settings.selected_extension}_binds_${split[0] == '' ? i : split[0]}`;

            items.push({
                type:    'string',
                title:   split[1],
                setting: setting_key
            });
        }
    }

    return items;
}

function get_user_settings(settings) {
    // Get the settings from the input provided by the user
    let docker;

    for (const key in settings) {
        if (key.includes("docker_")) {
            // Keys are in the form: docker_<name>_<field_type>_<field_name>
            const split = key.split('_');
            const name = split[1];
            const field = split[2];

            if (settings[key]) {
                if (!docker)              docker = {};
                if (!docker[name])        docker[name] = {};
                if (!docker[name][field]) docker[name][field] = {};

                // This setting has to be passed on towards Docker
                if (field == 'devices' || field == 'binds') {
                    if (split[3].indexOf('/') == 0) {
                        // The set value contains the host path, the setting name contains the container path
                        docker[name][field][settings[key]] = split.slice(3).join('_');
                    } else {
                        // one on one path mapping
                        docker[name][field][settings[key]] = settings[key];
                    }
                } else if (field == 'env') {
                    // Join all remaining segments to allow underscores in environment names
                    docker[name][field][split.slice(3).join('_')] = settings[key];
                } else {
                    docker[name][field][split[3]] = settings[key];
                }
            } else if (field == 'devices') {
                if (!docker)              docker = {};
                if (!docker[name])        docker[name] = {};
                if (!docker[name][field]) docker[name][field] = {};

                //Fallback to the container path for devices that haven't been set by user
                docker[name][field][split.slice(3).join('_')] = split.slice(3).join('_');
            }
        }
    }

    return docker;
}

function get_settings_data(settings, cb) {
    if (installer.is_idle()) {
        installer.load_repository((version) => {
            if (version) {
                settings.repo_version = version;
            }

            get_installation_settings(undefined, settings, cb);
        });
    } else {
        get_installation_settings(undefined, settings, cb);
    }
}

function get_installation_settings(options, settings, cb) {
    // Get the settings from the installed instance of the extension
    const name = settings.selected_extension;

    installer.get_extension_pull_count(name, () => {
        if (!name || (options && options[name])) {
            cb && cb();
        } else {
            installer.get_extension_settings(name, (options) => {
                // Inject options in settings
                // Keys are in the form: docker_<name>_<field_type>_<field_name>
                for (const field_type in options) {
                    for (const field_name in options[field_type]) {
                        if (field_type == 'env') {
                            settings[`docker_${name}_${field_type}_${field_name}`] = options[field_type][field_name];
                        } else {
                            settings[`docker_${name}_${field_type}_${options[field_type][field_name]}`] = field_name;
                        }
                    }
                }

                cb && cb();
            });
        }
    });
}

function remove_docker_options(settings) {
    for (const key in settings) {
        if (key.includes("docker_")) {
            delete settings[key];
        }
    }
}

function is_pending(name) {
    return pending_actions[name];
}

function update_pending_actions(settings, cb) {
    const name = settings.selected_extension;
    const action = settings.action;
    const global_action = settings.global_action;
    const options = get_user_settings(settings);

    if (action !== undefined) {
        if (action === ACTION_NO_CHANGE) {
            // Remove action from pending_actions
            delete pending_actions[name];
        } else {
            // Update pending actions
            for (let i = 0; i < action_list.length; i++) {
                if (action_list[i].value === action) {
                    const friendly = action_list[i].title + " " + installer.get_details(name).display_name;

                    pending_actions[name] = {
                        action,
                        friendly,
                        options: options && options[name]
                    };

                    break;
                }
            }
        }

        // Cleanup
        delete settings.action;
    } else if (pending_actions[name] && options && options[name]) {
        pending_actions[name].options = options[name];
    }

    if (global_action !== undefined) {
        if (global_action === GLOBAL_LOGS) {
            pending_actions.global = {
                action:   GLOBAL_LOGS,
                friendly: 'Collect Logs'
            };
        }

        // Cleanup
        delete settings.global_action;
    }

    get_installation_settings(options, settings, cb);
}

function get_pending_actions_string() {
    let pending_actions_string = ""

    for (const name in pending_actions) {
        pending_actions_string += pending_actions[name].friendly + "\n";
    }

    if (!pending_actions_string) {
        pending_actions_string = "(none)";
    }

    return pending_actions_string;
}

function perform_pending_actions() {
    if (pending_actions.global) {
        const global_action = pending_actions.global.action;

        delete pending_actions.global;

        if (global_action === GLOBAL_LOGS) {
            installer.export_logs(() => {
                installer.perform_actions(pending_actions);
            });
        }
    } else {
        installer.perform_actions(pending_actions);
    }
}

function set_update_timer() {
    const valid_time = timer.validate_time_string(ext_settings.update_time);

    if (timeout_id != null) {
        // Clear pending timeout
        clearTimeout(timeout_id);
        timeout_id = null;
    }

    if (valid_time) {
        const now = Date.now();
        let date = new Date(now);

        date.setMilliseconds(0);
        date.setSeconds(0);
        date.setMinutes(valid_time.minutes);
        date.setHours(valid_time.hours);

        if (date.getTime() <= now) {
            // Time has passed for today
            date.setDate(date.getDate() + 1);   // Corrects for days per month and daylight saving time
        }

        timeout_id = setTimeout(timer_timed_out, date.getTime() - now);
    }
}

function timer_timed_out() {
    timeout_id = null;

    console.log("It's update time!");
    installer.update_all();

    set_update_timer();
}

function setup_ping_timer() {
    if (!ping_timer_id) {
        ping_timer_id = setInterval(ping, 60000);
        console.log('Ping timer set');
    }
}

function ping() {
    // Check if the Roon API is still running fine by refreshing the status message
    svc_status.set_status(last_message, last_is_error);
}

function clear_ping_timer() {
    if (ping_timer_id) {
        clearInterval(ping_timer_id);
        console.log('Ping timer cleared');
    }
}

function setup_watchdog_timer() {
    clear_watchdog_timer();

    watchdog_timer_id = setTimeout(installer.restart_manager, 30000);
    console.log('Watchdog timer set');
}

function clear_watchdog_timer() {
    if (watchdog_timer_id) {
        clearTimeout(watchdog_timer_id);
        console.log('Watchdog timer cleared');
    }
}

function set_status(message, is_error) {
    svc_status.set_status(message, is_error);

    last_message = message;
    last_is_error = is_error;
}

var http = require('http');
http.createServer(function(request, response) {
    const fs = require('fs');

    installer.get_logs_archive((stream) => {
        response.writeHead(200, { 'Content-Type': 'application/gzip' });

        stream.pipe(response);
    });
}).listen(PORT);

function get_ip() {
    const os = require('os');
    const ifaces = os.networkInterfaces();

    for (const ifname in ifaces) {
        const iface = ifaces[ifname];

        for (let i = 0; i < iface.length; i++) {
            if (iface[i].family == 'IPv4' && !iface[i].internal) {
                return iface[i].address;
            }
        }
    }

    return undefined;
}

function init() {
    let os = require("os");
    let hostname = os.hostname().split(".")[0];

    roon.extension_reginfo.extension_id += "." + hostname;
    roon.extension_reginfo.display_name += " @" + hostname;

    set_update_timer();
}

init();
