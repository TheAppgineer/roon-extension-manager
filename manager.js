// Copyright 2017 The Appgineer
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

const ACTION_NO_CHANGE = 1;
const ACTION_INSTALL = 2;
const ACTION_UPDATE = 3;
const ACTION_UNINSTALL = 4;
const ACTION_START = 5;
const ACTION_STOP = 6;

var core;
var pending_actions = {};
var extension_list = [];
var timeout_id = null;
var watchdog_timer_id = null;
var last_message;
var last_is_error;

var roon = new RoonApi({
    extension_id:        'com.theappgineer.extension-manager',
    display_name:        "Roon Extension Manager",
    display_version:     "0.3.0",
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             'https://community.roonlabs.com/t/roon-extension-manager/26632',

    core_paired: function(core_) {
        core = core_;
        console.log("Core paired.");

        setup_watchdog_timer();
    },
    core_unpaired: function(core_) {
        core = undefined;
        console.log("Core unpaired!");

        clear_watchdog_timer();
        installer.restart_manager();
    }
});

var ext_settings = roon.load_config("settings") || {
    update_time: "02:00",
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
            delete l.values.selected_extension;

            ext_settings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", ext_settings);

            set_update_timer();
            perform_pending_actions();
        }
    }
});

var svc_status = new RoonApiStatus(roon);
var timer = new ApiTimeInput();

var installer = new ApiExtensionInstaller({
    repository_changed: function(values) {
        extension_list = values;
    },
    installs_changed: function(installed) {
        console.log(installed);
    },
    updates_changed: function(updates) {
        console.log(updates);
    },
    status_changed: function(message, is_error) {
        last_message = message;
        last_is_error = is_error;

        svc_status.set_status(message, is_error);
    }
}, process.argv[2], process.argv[3] != 'service');

roon.init_services({
    provided_services: [ svc_settings, svc_status ]
});

function makelayout(settings) {
    let l = {
        values:    settings,
        layout:    [],
        has_error: false
    };

    if (extension_list) {
        let global = {
            type:    "group",
            title:   "[GLOBAL SETTINGS]",
            items:   []
        };
        let update = {
            type:    "string",
            title:   "Check for updates @ [hh:mm]",
            setting: "update_time"
        };
        let selector = {
            type:    "dropdown",
            title:   "[EXTENSION]",
            values:  [{ title: "(select extension)", value: undefined }],
            setting: "selected_extension"
        };
        let extension = {
            type:    "group",
            title:   "(no extension selected)",
            items:   [],
        };
        let status = {
            type:    "label",
        };
        let action = {
            type:    "dropdown",
            title:   "Action",
            values:  [{ title: "(select action)", value: undefined  }],
            setting: "action"
        }

        selector.values = selector.values.concat(extension_list);

        global.items.push(update);

        if (settings.update_time) {
            let valid_time = timer.validate_time_string(settings.update_time);

            if (valid_time) {
                settings.update_time = valid_time.friendly;
            } else {
                update.error = "Time should conform to format: hh:mm[am|pm]";
                l.has_error = true;
            }
        }

        let index = settings.selected_extension;
        if (index != undefined) {
            let details = installer.get_details(index);

            if (details.description) {
                extension.title = details.description;
            } else {
                extension.title = "(no description)";
            }

            const version = is_installed(index);
            status.title = (version ? "INSTALLED: version " + version : "NOT INSTALLED")

            if (is_pending(index)) {
                action.values.push({ title: "Revert Action", value: ACTION_NO_CHANGE });
            } else if (is_installed(index)) {
                if (installer.has_update(index)) {
                    action.values.push({ title: "Update", value: ACTION_UPDATE });
                }
                action.values.push({ title: "Uninstall", value: ACTION_UNINSTALL });
                if (is_running(index)) {
                    action.values.push({ title: "Stop", value: ACTION_STOP });
                } else {
                    action.values.push({ title: "Start", value: ACTION_START });
                }
            } else {
                action.values.push({ title: "Install", value: ACTION_INSTALL });
            }

            extension.items.push({
                type: "label",
                title: "by: " + details.author
            });
            extension.items.push(status);
            extension.items.push(action);
        }

        l.layout.push(global);
        l.layout.push(selector);
        l.layout.push(extension);

        l.layout.push({
            type:    "group",
            title:   "[PENDING ACTIONS]",
            items:   [{
                type : "label",
                title: get_pending_actions_string()
            }]
        });
    } else {
        l.layout.push({
            type:    "label",
            title:   "No repository found"
        });
    }

    return l;
}

function is_installed(repos_index) {
    return installer.get_status(repos_index).version;
}

function is_running(repos_index) {
    return (installer.get_status(repos_index).state == 'running');
}

function is_pending(repos_index) {
    for (let index in pending_actions) {
        if (index == repos_index) {
            return true;
        }
    }

    return false;
}

function update_pending_actions(settings) {
    let repos_index = settings.selected_extension;
    let action = settings.action;

    if (action) {
        if (action == ACTION_NO_CHANGE) {
            // Remove action from pending_actions
            delete pending_actions["" + repos_index];
        } else {
            let friendly;

            // Update pending actions
            switch (action) {
                case ACTION_INSTALL:
                    friendly = "Install ";
                    break;
                case ACTION_UPDATE:
                    friendly = "Update ";
                    break;
                case ACTION_UNINSTALL:
                    friendly = "Uninstall ";
                    break;
                case ACTION_START:
                    friendly = "Start ";
                    break;
                case ACTION_STOP:
                    friendly = "Stop ";
                    break;
            }

            friendly += installer.get_details(repos_index).display_name;

            let pending_action = {
                action: action,
                friendly: friendly
            };

            pending_actions["" + repos_index] = pending_action;
        }

        // Cleanup action
        delete settings["action"];
    }
}

function get_pending_actions_string() {
    let pending_actions_string = ""

    for (let repos_index in pending_actions) {
        pending_actions_string += pending_actions[repos_index].friendly + "\n";
    }

    if (!pending_actions_string) {
        pending_actions_string = "(none)";
    }

    return pending_actions_string;
}

function perform_pending_actions() {
    for (let repos_index in pending_actions) {

        switch (pending_actions[repos_index].action) {
            case ACTION_INSTALL:
                installer.install(+repos_index);
                break;
            case ACTION_UPDATE:
                installer.update(+repos_index);
                break;
            case ACTION_UNINSTALL:
                installer.uninstall(+repos_index);
                break;
            case ACTION_START:
                installer.start(+repos_index);
                break;
            case ACTION_STOP:
                installer.stop(+repos_index);
                break;
        }
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

function setup_watchdog_timer() {
    clear_watchdog_timer();

    watchdog_timer_id = setInterval(kick_watchdog, 60000);
}

function kick_watchdog() {
    // Check if the Roon API is still running fine by refreshing the status message
    svc_status.set_status(last_message, last_is_error);
}

function clear_watchdog_timer() {
    if (watchdog_timer_id) {
        clearInterval(watchdog_timer_id);
    }
}

function init() {
    let os = require("os");
    let hostname = os.hostname().split(".")[0];

    roon.extension_reginfo.extension_id += "." + hostname;
    roon.extension_reginfo.display_name += " @" + hostname;

    set_update_timer();
}

init();
roon.start_discovery();
