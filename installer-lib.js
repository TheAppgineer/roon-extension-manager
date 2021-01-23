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

// System category entries
const SYSTEM_NAME  = "System";
const MANAGER_NAME = "roon-extension-manager";
const REPOS_NAME   = 'roon-extension-repository';

const MIN_REPOS_VERSION = "1.0.0"

const repos_system = {
    display_name: SYSTEM_NAME,
    extensions: [{
        name: MANAGER_NAME,
        author: "The Appgineer",
        display_name: "Extension Manager",
        description: "Roon Extension for managing Roon Extensions"
    },
    {
        name: REPOS_NAME,
        author: "The Appgineer",
        display_name: "Extension Repository",
        description: "Repository of (community developed) Roon Extensions"
    }]
};

const ACTION_INSTALL = 1;
const ACTION_UPDATE = 2;
const ACTION_UNINSTALL = 3;
const ACTION_START = 4;
const ACTION_START_AND_LOG = 5;
const ACTION_RESTART = 6;
const ACTION_RESTART_AND_LOG = 7;
const ACTION_STOP = 8;

const action_strings = [
    '',
    'Install',
    'Update',
    'Uninstall',
    'Start',
    'Start (with logging)',
    'Restart',
    'Restart (with logging)',
    'Stop'
];

const stdout_write = process.stdout.write;
const stderr_write = process.stderr.write;
const extension_root = `${process.cwd()}/.rem/`;
const backup_dir = 'backup/';
const repos_dir = 'repos/';
const log_dir = 'log/';
const binds_dir = 'binds/';
const perform_restart = 67;

const fs = require('fs');
var ApiExtensionInstallerDocker = require('./docker-lib');

var write_stream;
var docker;
var features;
var repos;
var index_cache = {};
var docker_installed = {};
var containerized;
var updates_list = {};
var action_queue = {};
var logging_active = false;
var logs_list = {};
var session_error;

var repository_cb;
var status_cb;
var on_activity_changed;

function ApiExtensionInstaller(callbacks, logging, features_file) {
    const mkdirp = require('mkdirp');

    process.on('SIGTERM', _handle_signal);
    process.on('SIGINT', _handle_signal);
    process.on('SIGBREAK', _handle_signal);

    if (callbacks) {
        if (callbacks.repository_changed) {
            repository_cb = callbacks.repository_changed;
        }
        if (callbacks.status_changed) {
            status_cb = callbacks.status_changed;
        }
    }

    if (features_file) {
        features = _read_JSON_file_sync(features_file);
    }

    if (!features && extension_root) {
        features = _read_JSON_file_sync(extension_root + 'features.json');
    }

    // Create log directory
    extension_root && mkdirp(extension_root + log_dir, (err, made) => {
        if (err) {
            console.error(err);
        } else {
            let logs_array = [];

            _set_status("Starting Roon Extension Manager...", false);

            if (!features || features.log_mode != 'off') {
                // Logging feature active
                if (logging) {
                    // Logging enabled
                    logs_array = _read_JSON_file_sync('logging.json');
                    if (logs_array === undefined) logs_array = [];

                    if (logs_array && logs_array.includes(MANAGER_NAME) &&
                            (!features || features.log_mode != 'child_nodes')) {
                        // Start logging of manager stdout
                        const fd = _get_log_descriptor(MANAGER_NAME);
                        write_stream = fs.createWriteStream('', {flags: 'a', fd: fd});

                        process.stdout.write = function() {
                            stdout_write.apply(process.stdout, arguments);
                            write_stream.write.apply(write_stream, arguments);
                        };
                        process.stderr.write = function() {
                            stderr_write.apply(process.stderr, arguments);
                            write_stream.write.apply(write_stream, arguments);
                        };
                    }
                }

                logging_active = logging;
            }

            // Create backup directory, used during update
            mkdirp(extension_root + backup_dir, (err, made) => {
                if (err) {
                    console.error(err);
                }
            });

            docker = new ApiExtensionInstallerDocker((err, installed) => {
                if (err) {
                    _set_status('Extension Manager requires Docker!', true);
                } else {
                    _set_status(`Docker for Linux found: Version ${docker.get_status().version}`, false);

                    docker_installed = installed;

                    for (let i = 0; i < logs_array.length; i++) {
                        const name = logs_array[i];

                        if (docker_installed[name] && docker.get_status(name).state == 'running') {
                            console.log("Capturing log stream of " + name);
                            docker.log(name, _get_log_descriptor(name));
                        }
                    }
                }

                // Get extension repository
                _queue_action(REPOS_NAME, { action: ACTION_INSTALL });

                callbacks.started && callbacks.started();
            });
        }
    });
}

ApiExtensionInstaller.prototype.get_extensions_by_category = function(category_index) {
    const extensions = repos.categories[category_index].extensions;
    let values = [];

    // Collect extensions
    for (let i = 0; i < extensions.length; i++) {
        if (extensions[i].display_name) {
            const name = _get_name(extensions[i]);

            values.push({
                title: extensions[i].display_name,
                value: name
            });

            // Take the opportunity to cache the item
            index_cache[name] = [category_index, i];
        }
    }

    values.sort(_compare);

    return values;
}

ApiExtensionInstaller.prototype.update = function(name) {
    ApiExtensionInstaller.prototype.perform_action.call(this, ACTION_UPDATE, name);
}

ApiExtensionInstaller.prototype.update_all = function() {
    if (!features || features.auto_update != 'off') {
        _query_updates(_queue_updates);
    }
}

ApiExtensionInstaller.prototype.restart_manager = function() {
    _restart(MANAGER_NAME, logging_active ? logs_list[MANAGER_NAME] : undefined);
}

/**
 * Returns the status of an extension identified by name
 *
 * @param {String} name - The name of the extension according to its package.json file
 * @returns {('not_installed'|'installed'|'stopped'|'terminated'|'running')} - The status of the extension
 */
ApiExtensionInstaller.prototype.get_status = function(name) {
    if (name == REPOS_NAME) {
        const version = repos && repos.version;
        const state = (version ? 'installed' : 'not_installed');

        return {
            state:   state,
            version: version
        };
    } else {
        let status = docker.get_status(name);

        status.logging = (logs_list[name] !== undefined);

        return status;
    }
}

ApiExtensionInstaller.prototype.get_details = function(name) {
    const extension = _get_extension(name);

    return {
        author:       extension.author,
        packager:     extension.packager,
        display_name: extension.display_name,
        description:  extension.description
    };
}

ApiExtensionInstaller.prototype.get_actions = function(name) {
    const state = ApiExtensionInstaller.prototype.get_status.call(this, name).state;
    let actions = [];
    let options;

    if (state == 'not_installed') {
        const extension = _get_extension(name);

        actions.push(_create_action_pair(ACTION_INSTALL));

        if (extension.image) {
            options = docker.get_install_options(extension.image);
        }
    } else {
        if (name == REPOS_NAME) {
            actions.push(_create_action_pair(ACTION_UPDATE));
        } else if (name == MANAGER_NAME) {
            if (state == 'running') {
                actions.push(_create_action_pair(ACTION_RESTART));

                if (logging_active) {
                    actions.push(_create_action_pair(ACTION_RESTART_AND_LOG));
                }
            }
        } else {
            if (updates_list[name]) {
                actions.push(_create_action_pair(ACTION_UPDATE));
            }

            actions.push(_create_action_pair(ACTION_UNINSTALL));

            if (state == 'running') {
                actions.push(_create_action_pair(ACTION_RESTART));
                if (logging_active) {
                    actions.push(_create_action_pair(ACTION_RESTART_AND_LOG));
                }
                actions.push(_create_action_pair(ACTION_STOP));
            } else {
                actions.push(_create_action_pair(ACTION_START));
                if (logging_active) {
                    actions.push(_create_action_pair(ACTION_START_AND_LOG));
                }
            }
        }
    }

    return {
        actions: actions,
        options: options
    };
}

ApiExtensionInstaller.prototype.get_features = function() {
    return features;
}

ApiExtensionInstaller.prototype.set_log_state = function(logging) {
    if ((!logging_active && logging) || (logging_active && !logging)) {
        // State changed
        _restart(MANAGER_NAME);
    }
}

ApiExtensionInstaller.prototype.perform_action = function(action, name, options) {
    switch (action) {
        case ACTION_INSTALL:
            _queue_action(name, { action: ACTION_INSTALL, options: options });
            break;
        case ACTION_UPDATE:
            if (name == REPOS_NAME || updates_list[name]) {
                let update = {};

                update[name] = updates_list[name];
                _queue_updates(update);
            }
            break;
        case ACTION_UNINSTALL:
            _queue_action(name, { action: ACTION_UNINSTALL });
            break;
        case ACTION_START:
            _start(name, false);
            break;
        case ACTION_START_AND_LOG:
            _start(name, true);
            break;
        case ACTION_RESTART:
            _restart(name, false);
            break;
        case ACTION_RESTART_AND_LOG:
            _restart(name, true);
            break;
        case ACTION_STOP:
            _stop(name, true);
            break;
    }
}

ApiExtensionInstaller.prototype.set_on_activity_changed = function(cb) {
    on_activity_changed = cb;
}

ApiExtensionInstaller.prototype.is_idle = function(name) {
    return (name ? !action_queue[name] : !Object.keys(action_queue).length);
}

ApiExtensionInstaller.prototype.get_logs_archive = function(cb) {
    const tar = require('tar');
    const backup_file = extension_root + backup_dir + 'extension-logs.tar.gz';
    const options = { file: backup_file, cwd: extension_root, gzip: true };

    tar.create(options, [log_dir], () => {
        cb && cb(backup_file);
    });
}

function _create_action_pair(action) {
    return {
        title: action_strings[action],
        value: action
    };
}

function _update_repository() {
    _download_repository((data) => {
        if (data) {
            const parsed = JSON.parse(data);
            const changed = (repos == undefined ||
                             (parsed.version != repos.version && parsed.version >= MIN_REPOS_VERSION));

            if (changed) {
                _load_repository(parsed);
            } else {
                _set_status("Extension Repository already up to date", false);
            }

            _remove_action(REPOS_NAME);
        }
    });
}

function _download_repository(cb) {
    const https = require('https');
    const url = "https://raw.githubusercontent.com/TheAppgineer/roon-extension-repository/v1.x/repository.json";

    https.get(url, (response) => {
        if (response.statusCode == 200) {
            let body = "";

            response.on('data', (data) => {
                body += data;
            });
            response.on('end', () => {
                cb && cb(body);
            });
        } else {
            if (response.statusCode == 404) {
                console.log('repository.json file not found');
            } else {
                console.error(data.toString());
            }

            cb && cb();
        }
    }).on('error', (err) => {
        console.error(err);
    });
}

function _load_repository(new_repo) {
    const local_repos = extension_root + repos_dir;

    repos = new_repo;
    repos.categories.unshift(repos_system);

    fs.readdir(local_repos, (err, files) => {
        if (!err) {
            for(let i = 0; i < files.length; i++) {
                _add_to_repository(local_repos + files[i], repos.categories);
            };
        }

        if (repos.categories.length) {
            let values = [];

            // Collect extension categories
            for (let i = 0; i < repos.categories.length; i++) {
                if (repos.categories[i].display_name) {
                    values.push({
                        title: repos.categories[i].display_name,
                        value: i
                    });
                }
            }

            docker_installed = _get_docker_installed_extensions(docker_installed);
            console.log(docker_installed);

            _set_status(`Extension Repository loaded (v${repos.version})`, false);

            _query_updates(() => {
                repository_cb && repository_cb(values);
            });
        } else {
            _set_status("Extension Repository not found", true);

            repository_cb && repository_cb();
        }
    });
}

function _add_to_repository(file, base) {
    if (file.includes('.json')) {
        const new_repo = _read_JSON_file_sync(file);

        if (new_repo) {
            const docker_install_active = (docker.get_status().version ? true : false);

            for (let i = 0; i < new_repo.length; i++) {
                let filtered = {
                    display_name: new_repo[i].display_name,
                    extensions: []
                };
                let j;

                // Is the install type available and active?
                for (j = 0; j < new_repo[i].extensions.length; j++) {
                    if (new_repo[i].extensions[j].image && docker_install_active) {
                        filtered.extensions.push(new_repo[i].extensions[j]);
                    }
                }

                // Does category already exist?
                for (j = 0; j < base.length; j++) {
                    if (base[j].display_name == filtered.display_name) {
                        break;
                    }
                }

                if (filtered.extensions.length) {
                    if (j === base.length) {
                        // New category
                        base.push(filtered);
                    } else {
                        // Add to existing category
                        base[j].extensions = base[j].extensions.concat(filtered.extensions);
                    }
                }
            }
        }
    }
}

function _get_docker_installed_extensions(installed) {
    let installed_extensions = {};

    if (installed) {
        for (const name in installed) {
            // Only images that are included in the repository
            if (_get_index_pair(name)) {
                installed_extensions[name] = installed[name];

                if (name == MANAGER_NAME) {
                    // Looks like we're running in a container
                    containerized = true;
                }
            }
        }
    }

    return installed_extensions;
}

function _compare(a, b) {
    if (a.title.toLowerCase() < b.title.toLowerCase()) {
        return -1;
    }
    if (a.title.toLowerCase() > b.title.toLowerCase()) {
        return 1;
    }
    return 0;
}

function _get_name(extension) {
    let name = extension.name;

    if (extension.image) {
        name = docker.get_name(extension.image);
    }

    return name;
}

function _get_index_pair(name) {
    let index_pair = index_cache[name];

    if (!index_pair) {
        for (let i = 0; i < repos.categories.length; i++) {
            const extensions = repos.categories[i].extensions;

            for (let j = 0; j < extensions.length; j++) {
                const entry_name = _get_name(extensions[j]);

                index_cache[entry_name] = [i, j];

                if (entry_name == name) {
                    index_pair = index_cache[entry_name];
                    break;
                }
            }
        }
    }

    return index_pair;
}

function _get_extension(name) {
    const index_pair = _get_index_pair(name);

    return repos.categories[index_pair[0]].extensions[index_pair[1]];
}

function _install(name, options, cb) {
    if (name) {
        if (name == REPOS_NAME) {
            _set_status('Loading Extension Repository...', false);

            _update_repository();
        } else {
            const bind_props = {
                root:       extension_root,
                binds_path: binds_dir + name,
                name:       (containerized ? MANAGER_NAME : undefined)
            };

            _set_status("Installing: " + name + "...", false);

            docker.install(_get_extension(name).image, bind_props, options, (err, tag) => {
                if (err) {
                    _set_status("Installation failed: " + name, true);
                    console.error(err);
                } else {
                    docker_installed[name] = tag;
                }

                cb && cb(name);
            });
        }
    }
}

function _register_installed_version(name, err) {
    _register_version(name, false, err);
}

function _register_updated_version(name, err) {
    _register_version(name, true, err);
}

function _register_version(name, update, err) {
    const version = docker_installed[name];

    if (err) {
        _set_status((update ? 'Update' : 'Installation') + ' failed: ' + name, true);
    } else if (version) {
        _set_status((update ? 'Updated: ' : 'Installed: ') + name + ' (' + version + ')', false);

        if (update) {
            const state = ApiExtensionInstaller.prototype.get_status.call(this, name).state;

            if (state != 'stopped') {
                _start(name);
            }
        } else {
            _start(name, false);
        }

        _query_updates(null, name);
    }

    // Update administration
    _remove_action(name);
    session_error = undefined;
}

function _update(name, cb) {
    if (name && name != MANAGER_NAME) {
        _stop(name, false, () => {
            _set_status("Updating: " + name + "...", false);

            if (name == REPOS_NAME) {
                _update_repository();
            } else if (docker_installed[name]) {
                docker.update(name, (err) => {
                    if (err) {
                        console.error(err);
                    }

                    cb && cb(name);
                });
            }
        });
    }
}

function _uninstall(name, cb) {
    if (name) {
        _stop(name, true, () => {
            _set_status("Uninstalling: " + name + "...", false);

            if (docker_installed[name]) {
                docker.uninstall(name, (err, installed) => {
                    if (err) {
                        _set_status("Uninstall failed: " + name, true);
                        console.error(err);
                    } else {
                        docker_installed = _get_docker_installed_extensions(installed);
                    }

                    cb && cb(name);
                });
            }
        });
    }
}

function _unregister_version(name) {
    _set_status("Uninstalled: " + name, false);
    _remove_action(name);
    session_error = undefined;
}

function _get_log_descriptor(name) {
    let descriptor = logs_list[name];

    // Get file descriptor if it hasn't been defined
    if (descriptor == undefined) {
        const log_file = extension_root + log_dir + name + '.log';

        descriptor = fs.openSync(log_file, 'a');
        logs_list[name] = descriptor;
    }

    return descriptor;
}

function _start(name, log) {
    let fd;

    if (log === undefined) {
        log = (logging_active && logs_list[name] !== undefined);
    } else if (log === false && logs_list[name] === null) {
        delete logs_list[name];     // Logging explicitly got deactivated
    }

    if (log) {
        fd = _get_log_descriptor(name);
    }

    if (docker_installed[name]) {
        docker.start(name, fd);
    }

    if (log) {
        _set_status("Started (with logging): " + name, false);
    } else {
        _set_status("Started: " + name, false);
    }
}

function _restart(name, log) {
    _stop(name, false, () => {
        if (name == MANAGER_NAME) {
            _terminate(perform_restart, log);
        } else {
            _start(name, log);
        }
    });
}

function _stop(name, user, cb) {
    _set_status("Terminating process: " + name + "...", false);

    if (docker_installed[name]) {
        if (user) {
            docker.stop(name, () => {
                _set_status("Stopped: " + name, false);

                cb && cb();
            });
        } else {
            docker.terminate(name, () => {
                _set_status("Process terminated: " + name, false);

                cb && cb();
            });
        }
    } else {
        cb && cb();
    }
}

function _terminate(exit_code, log) {
    if (logging_active) {
        // Close log files
        for (const name in logs_list) {
            if (name == MANAGER_NAME) {
                process.stdout.write = stdout_write;
                process.stderr.write = stderr_write;

                if (write_stream) {
                    write_stream.end();
                }
            }
        }

        if (log !== undefined) {
            // Logging specified
            if (log && !logs_list[MANAGER_NAME]) {
                // Switched on
                logs_list[MANAGER_NAME] = null;
            } else if (!log && logs_list[MANAGER_NAME]) {
                // Switched off
                delete logs_list[MANAGER_NAME];
            }
        }

        // Write names of logging extensions to file
        fs.writeFileSync('logging.json', JSON.stringify(Object.keys(logs_list)));
    }

    if (exit_code) {
        process.exit(exit_code);
    } else {
        process.exit(0);
    }
}

function _handle_signal(signal) {
    _terminate();
}

function _queue_action(name, action_props) {
    if (!action_queue[name]) {      // No action replace
        action_queue[name] = action_props;

        if (Object.keys(action_queue).length == 1) {
            on_activity_changed && on_activity_changed();
            _perform_action();
        }
    }
}

function _remove_action(name) {
    delete action_queue[name];

    _perform_action();      // Anything pending?
}

function _perform_action() {
    if (Object.keys(action_queue).length) {
        const name = Object.keys(action_queue)[0];

        if (!session_error) {
            // New session
            session_error = false;
        }

        switch (action_queue[name].action) {
            case ACTION_INSTALL:
                _install(name, action_queue[name].options, _register_installed_version);
                break;
            case ACTION_UPDATE:
                if (name == MANAGER_NAME || name == REPOS_NAME) {
                    _update(name);
                } else {
                    _update(name, _register_updated_version);
                }
                break;
            case ACTION_UNINSTALL:
                _uninstall(name, _unregister_version);
                break;
            default:
                // Not a session
                session_error = undefined;
                break;
        }
    } else {
        on_activity_changed && on_activity_changed();
    }
}

function _queue_updates(updates) {
    if (updates && Object.keys(updates).length) {
        for (const name in updates) {
            if (name != MANAGER_NAME) {
                _queue_action(name, { action: ACTION_UPDATE });
            }
        }
    } else {
        console.log("No updates found");
    }
}

function _query_updates(cb, name) {
    let results = {};

    if (Object.keys(docker_installed).length) {
        docker.query_updates((updates) => {
            for (const name in updates) {
                // Only images that are included in the repository
                if (name != MANAGER_NAME && _get_index_pair(name)) {
                    results[name] = updates[name];
                    updates_list[name] = updates[name];
                }
            }
        }, name);
    }

    if (cb) {
        cb(results);
    }
}

function _set_status(message, is_error) {
    const date = new Date();

    if (is_error) {
        console.error(date.toISOString(), '- Err:', message);
    } else {
        console.log(date.toISOString(), '- Inf:', message);
    }

    if (!session_error && status_cb) {
        status_cb(message, is_error);
    }

    if (session_error === false && is_error) {
        session_error = true;
    }
}

function _read_JSON_file_sync(file) {
    let parsed = undefined;

    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.toString().includes('SyntaxError')) {
            console.error(err);
        } else if (err.code !== 'ENOENT') {
            throw err;
        }
    }

    return parsed;
}

exports = module.exports = ApiExtensionInstaller;
