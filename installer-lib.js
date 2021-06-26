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

const system_extensions = [{
    author: "The Appgineer",
    display_name: "Extension Manager",
    description: "Roon Extension for managing Roon Extensions",
    image: {
        repo: `theappgineer/${MANAGER_NAME}`,
        tags: {
            amd64: "v1.x",
            arm:   "v1.x",
            arm64: "v1.x"
        }
    }
}];

const ACTION_INSTALL = 1;
const ACTION_UPDATE = 2;
const ACTION_UNINSTALL = 3;
const ACTION_START = 4;
const ACTION_RESTART = 5;
const ACTION_STOP = 6;

const action_strings = [
    '',
    'Install',
    'Update',
    'Uninstall',
    'Start',
    'Restart',
    'Stop'
];

const log_dir = 'log/';
const data_root = `${process.cwd()}/.rem/`;
const repos_dir = 'repos/';
const binds_dir = 'binds/';
const perform_update = 66;

const fs = require('fs');
const ApiExtensionInstallerDocker = require('./docker-lib');

var docker;
var features;
var repos = {};
var pull_counters = {};
var index_cache = {};
var docker_installed = {};
var install_options;
var action_queue = {};
var session_error;

var repository_cb;
var status_cb;
var on_activity_changed;

function ApiExtensionInstaller(callbacks, features_file) {
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

    if (!features && data_root) {
        features = _read_JSON_file_sync(`${data_root}features.json`);
    }

    // Load install_options from file
    install_options = _read_JSON_file_sync(`${data_root}install-options.json`) || {};

    // Create log directory
    mkdirp(log_dir, (err, made) => {
        if (err) {
            console.error(err);
        } else {
            _set_status("Starting Roon Extension Manager...", false);

            docker = new ApiExtensionInstallerDocker({
                on_startup: function(err, installed, version) {
                    if (err) {
                        _set_status('Extension Manager requires Docker!', true);
                    } else if (!installed[MANAGER_NAME]) {
                        _set_status('Extension Manager should run in Docker!', true);
                    } else {
                        _set_status(`Docker for Linux found: Version ${version}`, false);

                        docker_installed = installed;

                        // Get extension repository
                        _queue_action(REPOS_NAME, { action: ACTION_INSTALL });
                    }

                    callbacks.started && callbacks.started();
                },
                on_progress: function(layer_status) {
                    const name = [Object.keys(action_queue)[0]];
                    let status_string = (action_queue[name].action == ACTION_UPDATE ? 'Updating' : 'Installing');

                    status_string += `: ${name}`;

                    for (const layer in layer_status) {
                        status_string += `\n${layer_status[layer].status} layer: `;
                        status_string += layer_status[layer].progress;
                    }

                    _set_status(status_string);
                }
            });
        }
    });
}

ApiExtensionInstaller.prototype.load_repository = function(cb) {
    _update_repository((name, err) => {
        pull_counters = {};   // Get fresh pull counts

        if (!err) {
            _set_status(`${_get_display_name(name)} loaded (v${repos.version})`, false);

            cb && cb(repos.version);
        } else if (err == 'already up to date') {
            cb && cb(repos.version);
        } else {
            cb && cb();
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

ApiExtensionInstaller.prototype.update_all = function() {
    if (!features || features.auto_update != 'off') {
        _queue_updates(_query_updates());
    }
}

ApiExtensionInstaller.prototype.restart_manager = function() {
    _restart(MANAGER_NAME);
}

ApiExtensionInstaller.prototype.get_status = function(name) {
    return docker.get_status(name);
}

ApiExtensionInstaller.prototype.get_details = function(name) {
    const extension = _get_extension(name);

    return {
        author:       extension.author,
        packager:     extension.packager,
        display_name: extension.display_name,
        description:  extension.description,
        pull_count:   pull_counters[name]
    };
}

ApiExtensionInstaller.prototype.get_actions = function(name) {
    const state = ApiExtensionInstaller.prototype.get_status.call(this, name).state;
    let actions = [];

    if (state == 'not_installed') {
        actions.push(_create_action_pair(ACTION_INSTALL));
    } else if (name == MANAGER_NAME) {
        if (!features || features.self_update != 'off') {
            actions.push(_create_action_pair(ACTION_UPDATE));
        }

        if (state == 'running') {
            actions.push(_create_action_pair(ACTION_RESTART));
        }
    } else {
        actions.push(_create_action_pair(ACTION_UPDATE));
        actions.push(_create_action_pair(ACTION_UNINSTALL));

        if (state == 'running') {
            actions.push(_create_action_pair(ACTION_RESTART));
            actions.push(_create_action_pair(ACTION_STOP));
        } else {
            actions.push(_create_action_pair(ACTION_START));
        }
    }

    return actions;
}

ApiExtensionInstaller.prototype.get_extension_options = function(name, action) {
    const extension = _get_extension(name);
    let options;

    if (extension.image && (action == ACTION_INSTALL || action == ACTION_UPDATE)) {
        options = extension.image.options;
    }

    return options;
}

ApiExtensionInstaller.prototype.get_features = function() {
    return features;
}

ApiExtensionInstaller.prototype.get_extension_settings = function(name, cb) {
    const options = install_options[name];

    if (options || name == REPOS_NAME) {
        cb && cb(options);
    } else {
        docker.get_options_from_container(_get_extension(name).image, (err, options) => {
            if (options) {
                install_options[name] = options;
            }

            cb && cb(options);
        });
    }
}

ApiExtensionInstaller.prototype.get_extension_pull_count = function(name, cb) {
    let extension = name && _get_extension(name);

    if (extension && !pull_counters[name]) {
        const url = `https://hub.docker.com/v2/repositories/${extension.image.repo}/`;

        // https://forums.docker.com/t/api-to-read-the-pull-counter/66993/2
        _download(url, (err, data) => {
            if (data) {
                pull_counters[name] = JSON.parse(data).pull_count;
            }

            cb && cb();
        });
    } else {
        cb && cb();
    }
}

ApiExtensionInstaller.prototype.perform_actions = function(actions) {
    let updates = {}

    for (const name in actions) {
        const options = actions[name].options;

        switch (actions[name].action) {
            case ACTION_INSTALL:
                _queue_action(name, { action: ACTION_INSTALL, options: options });
                break;
            case ACTION_UPDATE:
                if (docker_installed[name]) {
                    updates[name] = docker_installed[name];
                    install_options[name] = options;
                }
                break;
            case ACTION_UNINSTALL:
                _queue_action(name, { action: ACTION_UNINSTALL });
                break;
            case ACTION_START:
                _start(name);
                break;
            case ACTION_RESTART:
                _restart(name);
                break;
            case ACTION_STOP:
                _stop(name, true);
                break;
        }

        // Consume action
        delete actions[name];
    }

    if (Object.keys(updates).length) {
        _queue_updates(updates, true);
    }
}

ApiExtensionInstaller.prototype.set_on_activity_changed = function(cb) {
    on_activity_changed = cb;
}

ApiExtensionInstaller.prototype.is_idle = function(name) {
    return (name ? !action_queue[name] : !Object.keys(action_queue).length);
}

ApiExtensionInstaller.prototype.export_logs = function(cb) {
    let index = 0;

    _get_log(index, cb);
}

ApiExtensionInstaller.prototype.get_logs_archive = function(cb) {
    const tar = require('tar');
    const options = { gzip: true };

    cb && cb(tar.create(options, [log_dir]));
}

function _create_action_pair(action) {
    return {
        title: action_strings[action],
        value: action
    };
}

function _update_repository(cb) {
    const url = "https://raw.githubusercontent.com/TheAppgineer/roon-extension-repository/v1.x/repository.json";

    _download(url, (err, data) => {
        if (data) {
            const parsed = JSON.parse(data);
            // TODO: Check layout compatibility:
            // Equal major (major indicates breaking layout change)
            // Less or equal minor (minor indicates backwards compatible layout change, e.g. addition of new field)
            // Not equal revision (revision indicates addition of extension)
            const changed = (repos == undefined ||
                             (parsed.version != repos.version && parsed.version >= MIN_REPOS_VERSION));

            if (changed) {
                _load_repository(parsed, cb);
            } else {
                cb && cb(REPOS_NAME, 'already up to date');
            }
        }
    });
}

function _download(url, cb) {
    const https = require('https');

    https.get(url, (response) => {
        if (response.statusCode == 200) {
            let body = "";

            response.on('data', (data) => {
                body += data;
            });
            response.on('end', () => {
                cb && cb(undefined, body);
            });
        } else {
            cb && cb(response.statusCode);
        }
    }).on('error', (err) => {
        cb && cb(err);
    });
}

function _load_repository(new_repo, cb) {
    const local_repos = data_root + repos_dir;

    repos.version = new_repo.version;
    repos.categories = [{ display_name: SYSTEM_NAME }];

    // Use concat to create a clone of the system_extensions array
    repos.categories[0].extensions = [].concat(system_extensions);

    _add_to_repository(new_repo.categories, repos.categories);

    fs.readdir(local_repos, (err, files) => {
        if (!err) {
            for(let i = 0; i < files.length; i++) {
                if (files[i].includes('.json')) {
                    const new_repo = _read_JSON_file_sync(local_repos + files[i]);

                    _add_to_repository(new_repo, repos.categories);
                }
            }
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

            cb && cb(REPOS_NAME);

            repository_cb && repository_cb(values);
        } else {
            cb && cb(REPOS_NAME, 'not found');

            repository_cb && repository_cb();
        }
    });
}

function _add_to_repository(new_repo, base) {
    if (new_repo) {
        for (let i = 0; i < new_repo.length; i++) {
            let filtered = {
                display_name: new_repo[i].display_name,
                extensions: []
            };
            let j;

            // Is the architecture type available?
            for (j = 0; j < new_repo[i].extensions.length; j++) {
                if (new_repo[i].extensions[j].image.tags[docker.get_arch()]) {
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

function _get_docker_installed_extensions(installed) {
    let installed_extensions = {};

    if (installed) {
        for (const name in installed) {
            // Only images that are included in the repository
            if (_get_index_pair(name)) {
                installed_extensions[name] = installed[name];
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

function _get_display_name(name) {
    return (name == REPOS_NAME ? 'Extension Repository' : _get_extension(name).display_name);
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

function get_bind_props(name) {
    return {
        root:       data_root,
        binds_path: binds_dir + name,
        name:       MANAGER_NAME
    };
};

function _get_extension(name) {
    const index_pair = _get_index_pair(name);

    return repos.categories[index_pair[0]].extensions[index_pair[1]];
}

function _install(name, options, cb) {
    if (name) {
        if (name == REPOS_NAME) {
            _set_status('Loading Extension Repository...', false);

            _update_repository(cb);
        } else {
            const display_name = _get_display_name(name);

            _set_status(`Installing: ${display_name}...`, false);

            // Store options for future update requests
            install_options[name] = options;

            docker.install(_get_extension(name).image, get_bind_props(name), options, true, (err, tag) => {
                if (err) {
                    _set_status(`Installation failed: ${display_name}\n${err}`, true);
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
    const tag = docker_installed[name];
    const display_name = _get_display_name(name);

    if (err && err != 'already up to date') {
        _set_status(`${update ? 'Update' : 'Installation'} failed: ${display_name} ${err}`, true);
    } else if (tag) {
        if (err) {
            _set_status(`${display_name} ${err}`, false);
        } else {
            _set_status(`${update ? 'Updated:' : 'Installed:'} ${display_name} (${tag})`, false);
        }

        if (name == MANAGER_NAME) {
            if (!err) {
                process.exit(perform_update);
            }
        } else {
            if (update) {
                const state = ApiExtensionInstaller.prototype.get_status.call(this, name).state;

                if (state != 'stopped' && state != 'running') {
                    _start(name);
                }
            } else {
                _start(name);
            }
        }
    } else if (name == REPOS_NAME) {
        if (err) {
            _set_status(`${display_name} ${err}`, false);
        } else {
            _set_status(`${display_name} loaded (v${repos.version})`, false);
        }
    }

    // Update administration
    _remove_action(name);
    session_error = undefined;
}

function _update(name, recreate, cb) {
    if (name) {
        _set_status(`Updating: ${_get_display_name(name)}...`, false);

        if (name == REPOS_NAME) {
            _update_repository(cb);
        } else if (docker_installed[name]) {
            const image = _get_extension(name).image;
            const bind_props = get_bind_props(name);
            const options = install_options[name];

            if (options) {
                docker.install(image, bind_props, options, recreate, (err) => {
                    cb && cb(name, err);
                });
            } else {
                docker.get_options_from_container(image, (err, options) => {
                    if (err) {
                        cb && cb(name, err);
                    } else {
                        // Store options for future update requests
                        install_options[name] = options;

                        docker.install(image, bind_props, options, recreate, (err) => {
                            cb && cb(name, err);
                        });
                    }
                });
            }
        }
    }
}

function _uninstall(name, cb) {
    if (name) {
        _stop(name, true, () => {
            const display_name = _get_display_name(name);

            _set_status(`Uninstalling: ${display_name}...`, false);

            if (docker_installed[name]) {
                docker.uninstall(name, (err, installed) => {
                    if (err) {
                        _set_status(`Uninstall failed: ${display_name}\n${err}`, true);
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
    _set_status(`Uninstalled: ${_get_display_name(name)}`, false);
    _remove_action(name);
    session_error = undefined;
}

function _get_log(index, cb) {
    const names = Object.keys(docker_installed);

    if (index < names.length) {
        const name = names[index];
        const log_file = log_dir + name + '.log';

        _set_status(`Collecting logs of ${_get_display_name(name)}...`);
        docker.get_log(name, log_file, () => {
            _get_log(index + 1, cb);
        });
    } else {
        _set_status('Logs collected, click above link to download');
        cb && cb();
    }
}

function _start(name) {
    if (docker_installed[name]) {
        docker.start(name, (err) => {
            if (err) {
                _set_status(`${_get_display_name(name)} failed to start:\n${err}`, true);
            } else {
                _set_status(`Started: ${_get_display_name(name)}`, false);
            }
        });
    }

}

function _restart(name) {
    if (name == MANAGER_NAME) {
        process.exit(0);
    } else {
        _stop(name, false, () => {
            _start(name);
        });
    }
}

function _stop(name, user, cb) {
    const state = ApiExtensionInstaller.prototype.get_status.call(this, name).state;

    if (docker_installed[name] && name != MANAGER_NAME && state == 'running') {
        const display_name = _get_display_name(name);

        _set_status(`Terminating process: ${display_name}...`, false);

        if (user) {
            docker.stop(name, () => {
                _set_status(`Stopped: ${display_name}`, false);

                cb && cb();
            });
        } else {
            docker.terminate(name, () => {
                _set_status(`Process terminated: ${display_name}`, false);

                cb && cb();
            });
        }
    } else {
        cb && cb();
    }
}

function _terminate(exit_code) {
    // Save install_options to file
    fs.writeFileSync(`${data_root}install-options.json`, JSON.stringify(install_options));

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
                _update(name, action_queue[name].recreate, _register_updated_version);
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

function _queue_updates(updates, manual) {
    if (updates) {
        // Update order: repository, extensions, self

        if (updates[REPOS_NAME]) {
            _queue_action(REPOS_NAME, { action: ACTION_UPDATE });

            delete updates[REPOS_NAME];
        }

        for (const name in updates) {
            if (name != MANAGER_NAME) {
                _queue_action(name, { action: ACTION_UPDATE, recreate: manual });
            }
        }

        if (updates[MANAGER_NAME] && (!features || features.self_update != 'off')) {
            _queue_action(MANAGER_NAME, { action: ACTION_UPDATE });
        }
    } else {
        console.log("No updates found");
    }
}

function _query_updates(name) {
    let results = {};

    if (name) {
        results[name] = docker_installed[name];
    } else {
        if (repos) {
            // Include repository in results
            results[REPOS_NAME] = repos.version
        }

        for (const name in docker_installed) {
            // Only images that are included in the repository
            if (_get_index_pair(name)) {
                results[name] = docker_installed[name];
            }
        }
    }

    return results;
}

function _set_status(message, is_error) {
    if (is_error) {
        console.error('Err:', message);
    } else {
        console.log('Inf:', message);
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