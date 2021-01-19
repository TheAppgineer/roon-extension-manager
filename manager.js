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
    ApiExtensionInstaller = require('node-api-extension-installer');

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
    display_version:     "1.0.0-beta1",
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
    update_time: "02:00",
    logging:     true
};

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        pending_actions = {};           // Start off with a clean list
        cb(makelayout(ext_settings));
    },
    save_settings: function(req, isdryrun, settings) {
        update_pending_actions(settings.values);

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
                installer.set_log_state(ext_settings.logging);
            } else {
                installer.set_on_activity_changed(() => {
                    installer.set_on_activity_changed();
                    installer.set_log_state(ext_settings.logging);
                });
            }
        }
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
}, ext_settings.logging, process.argv[2]);

roon.init_services({
    provided_services: [ svc_settings, svc_status ]
});

function makelayout(settings) {
    let l = {
        values:    settings,
        layout:    [],
        has_error: false
    };
    let global = {
        type:        "group",
        title:       "[GLOBAL SETTINGS]",
        collapsable: true,
        items:       []
    };
    let update = {
        type:    "string",
        title:   "Check for updates @ [hh:mm]",
        setting: "update_time"
    };
    const logging = {
        type:    "dropdown",
        title:   "Logging (change forces restart)",
        values:  [
            { title: "Disabled", value: false },
            { title: "Enabled",  value: true  }
        ],
        setting: "logging"
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

    if (!features || features.auto_update != 'off') {
        global.items.push(update);
    }

    if (!features || features.log_mode != 'off') {
        if (settings.logging === undefined) {
            settings.logging = false;
        }

        global.items.push(logging);
    }

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
            const actions = installer.get_actions(name);
            let author = {
                type: "label"
            };

            if (details.packager) {
                author.title  = "Developed by: " + details.author;
                author.title += "\nPackaged by:   " + details.packager;
            } else {
                author.title = "by: " + details.author;
            }

            if (details.description) {
                extension.title = details.description;
            } else {
                extension.title = "(no description)";
            }

            status_string.title  = status.state.toUpperCase();
            status_string.title += (status.logging ? " (with logging)" : "");
            status_string.title += (status.version ? ": version " + status.version : "");
            status_string.title += (status.tag ? ": tag " + status.tag : "");

            if (installer.is_idle(name)) {
                if (is_pending(name)) {
                    action_list = [{ title: 'Revert Action', value: ACTION_NO_CHANGE }];
                } else {
                    action_list = actions.actions;
                }

                action.values = action.values.concat(action_list);
            } else {
                action.values[0].title = '(in progress...)';
            }

            extension.items.push(author);
            extension.items.push(status_string);

            if (!is_pending(name) && actions.options) {
                extension.items.push(create_options_group(actions.options, settings));
            }

            extension.items.push(action);
        } else {
            settings.selected_extension = undefined;
            remove_docker_options(settings);
        }
    } else {
        settings.selected_category = undefined;
        settings.selected_extension = undefined;
        remove_docker_options(settings);
    }

    if (global.items.length) {
        l.layout.push(global);
    }

    l.layout.push({
        type:  "group",
        title: "[EXTENSION]",
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

function create_options_group(options, settings) {
    let options_group = {
        type:    "group",
        title:   "Docker Install Options",
        collapsable: true,
        items:   []
    };

    if (options.env) {
        for (const var_name in options.env) {
            options_group.items.push({
                type:    "string",
                title:   options.env[var_name],
                setting: "docker_env_" + var_name
            });
        }
    }
    if (options.devices) {
        for (let i = 0; i < options.devices.length; i++) {
            const split = options.devices[i].split(':');

            options_group.items.push({
                type:    "string",
                title:   (split[0] ? `${split[1]}\n(default ${split[0]})` : split[1]),
                setting: "docker_devices_" + (split[0] == '' ? i : split[0])
            });

            if (split[0]) {
                settings["docker_devices_" + split[0]] = '';
            }
        }
    }
    if (options.binds) {
        for (let i = 0; i < options.binds.length; i++) {
            const split = options.binds[i].split(':');

            options_group.items.push({
                type:    "string",
                title:   split[1],
                setting: "docker_binds_" + (split[0] == '' ? i : split[0])
            });
        }
    }

    return options_group;
}

function get_docker_options(settings) {
    let docker;

    for (const key in settings) {
        if (key.includes("docker_")) {
            // Keys are in the form: docker_<field_type>_<field_name>
            const split = key.split('_');
            const field = split[1];

            if (settings[key]) {
                if (!docker)        docker = {};
                if (!docker[field]) docker[field] = {};

                // This setting has to be passed on towards Docker
                if (field == 'devices' || field == 'binds') {
                    if (split[2].indexOf('/') == 0) {
                        // The set value contains the host path, the setting name contains the container path
                        docker[field][settings[key]] = split.slice(2).join('_');
                    } else {
                        // one on one path mapping
                        docker[field][settings[key]] = settings[key];
                    }
                } else if (field == 'env') {
                    // Join all remaining segments to allow underscores in environment names
                    docker[field][split.slice(2).join('_')] = settings[key];
                } else {
                    docker[field][split[2]] = settings[key];
                }
            } else if (field == 'devices') {
                if (!docker)        docker = {};
                if (!docker[field]) docker[field] = {};

                //Fallback to the container path for devices that haven't been set by user
                docker[field][split.slice(2).join('_')] = split.slice(2).join('_');
            }
        }
    }

    return docker;
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

function update_pending_actions(settings) {
    const name = settings.selected_extension;
    const action = settings.action;
    const options = get_docker_options(settings);

    if (action !== undefined) {
        if (action === ACTION_NO_CHANGE) {
            // Remove action from pending_actions
            delete pending_actions[name];
        } else {
            // Update pending actions
            for (let i = 0; i < action_list.length; i++) {
                if (action_list[i].value === action) {
                    let friendly = action_list[i].title + " " + installer.get_details(name).display_name;

                    if (options) {
                        friendly += ' (with options)';
                    }

                    pending_actions[name] = {
                        action,
                        friendly,
                        options
                    };

                    break;
                }
            }
        }

        // Cleanup
        remove_docker_options(settings);
        delete settings["action"];
    }
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
    for (const name in pending_actions) {
        installer.perform_action(pending_actions[name].action, name, pending_actions[name].options);

        // Consume action
        delete pending_actions[name];
    }
}

function set_update_timer() {
    let valid_time = timer.validate_time_string(ext_settings.update_time);

    if (valid_time) {
        const now = Date.now();
        let date = new Date(now);
        let tz_offset = date.getTimezoneOffset();

        date.setSeconds(0);
        date.setMilliseconds(0);
        date.setHours(valid_time.hours);
        date.setMinutes(valid_time.minutes);

        let timeout_time = date.getTime();

        if (timeout_time < now) {
            // Time has passed for today
            timeout_time += 24 * 60 * 60 * 1000;
        }

        date = new Date(timeout_time);
        tz_offset -= date.getTimezoneOffset();

        if (tz_offset) {
            timeout_time -= tz_offset * 60 * 1000;
        }

        timeout_time -= now;

        if (timeout_id != null) {
            // Clear pending timeout
            clearTimeout(timeout_id);
        }

        timeout_id = setTimeout(timer_timed_out, timeout_time);
    } else {
        // Clear pending timeout
        clearTimeout(timeout_id);
        timeout_id = null;
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
    const contentType = 'application/gzip';

    installer.get_logs_archive((file_path) => {
        fs.readFile(file_path, (error, content) => {
            if (error) {
                if(error.code == 'ENOENT'){
                    response.writeHead(404);
                    response.end('File not found\n');
                    response.end();
                }
                else {
                    response.writeHead(500);
                    response.end('An error occured: ' + error.code + '\n');
                    response.end();
                }

                set_status('Error reading logs archive: ' + error.code, true);
            }
            else {
                response.writeHead(200, { 'Content-Type': contentType });
                response.end(content, 'utf-8');

                set_status('Download request for logs archive processed', false);
            }
        });
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
