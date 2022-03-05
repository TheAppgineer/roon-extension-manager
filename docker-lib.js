// Copyright 2019 - 2022 The Appgineer
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

var Docker = require('dockerode');

var docker;
var docker_version;
var installed = {};
var states = {};
var started_at = {};
var log_config;
var on_progress_cb;

function ApiExtensionInstallerDocker(cbs) {
    docker = new Docker({ socketPath: '/var/run/docker.sock' });

    docker.version((err, version) => {
        if (!err && version.Version) {
            if (version.Os == 'linux') {
                docker_version = {
                    version: version.Version,
                    arch:    version.Arch
                };

                _query_installs((err, installed) => {
                    on_progress_cb = cbs.on_progress;
                    cbs && cbs.on_startup && cbs.on_startup(err, installed, version.Version);
                });
            } else {
                cbs && cbs.on_startup && cbs.on_startup('Host OS not supported: ' + version.Os);
            }
        } else {
            cbs && cbs.on_startup && cbs.on_startup('Docker not found');
        }
    });
}

ApiExtensionInstallerDocker.prototype.get_arch = function() {
    return docker_version.arch;
}

ApiExtensionInstallerDocker.prototype.get_status = function(name) {
    if (name) {
        const tag = installed[name];
        let state;
        let startup;

        state = (tag ? 'installed' : 'not_installed');

        if (state == 'installed') {
            // Get container state
            state = states[name];

            if (state == 'created' || state == 'exited') {
                // Convert Docker specific states to generic stopped state
                state = 'stopped';
            } else if (state == 'running') {
                startup = started_at[name];
            }
        }

        return {
            state,
            tag,
            startup
        };
    }
}

ApiExtensionInstallerDocker.prototype.get_name = function(image) {
    return _split(image.repo).repo;
}

ApiExtensionInstallerDocker.prototype.install = function(image, bind_props, options, recreate, cb) {
    if (docker_version && image && image.tags[docker_version.arch]) {
        let config = {};

        if (image.config) {
            // Create config copy via json stringify/parse sequence
            config = JSON.parse(JSON.stringify(image.config))
        }

        // Process options
        if (options) {
            if (options.env) {
                if (!config.Env) {
                    config.Env = [];
                }

                for (const name in options.env) {
                    config.Env.push(name + '=' + options.env[name]);
                }
            }

            if (options.devices) {
                if (!config.HostConfig) {
                    config.HostConfig = {};
                }

                if (!config.HostConfig.Devices) {
                    config.HostConfig.Devices = [];
                }

                for (const host in options.devices) {
                    config.HostConfig.Devices.push({
                        PathOnHost:        host,
                        PathInContainer:   options.devices[host],
                        CgroupPermissions: 'rwm'
                    });
                }
            }

            if (options.binds) {
                if (!config.Volumes) {
                    config.Volumes = {};
                }
                if (!config.HostConfig) {
                    config.HostConfig = {};
                }
                if (!config.HostConfig.Binds) {
                    config.HostConfig.Binds = [];
                }

                for (const host in options.binds) {
                    config.Volumes[options.binds[host]] = {};
                    config.HostConfig.Binds.push(host + ':' + options.binds[host]);
                }
            }
        }

        const container = docker.getContainer(bind_props.name);

        container.inspect((err, info) => {
            const repo_tag_string = image.repo + ':' + image.tags[docker_version.arch];

            log_config = info.HostConfig.LogConfig;

            // Process binds
            if (image.binds && image.binds.length && bind_props) {
                const volume = _get_volume(info, bind_props.root);

                if (!config.Volumes) {
                    config.Volumes = {};
                }
                if (!config.HostConfig) {
                    config.HostConfig = {};
                }
                if (!config.HostConfig.Binds) {
                    config.HostConfig.Binds = [];
                }

                bind_props.volume = volume;

                _create_bind_path_and_file(config, bind_props, image.binds, image.binds.length - 1, (err) => {
                    if (err) {
                        cb && cb(err);
                    } else {
                        if (volume && config.HostConfig.Binds.length) {
                            // Attach this container to the volume that holds the bind mount
                            config.Volumes[bind_props.root] = {};
                            config.HostConfig.Binds.push(volume.name + ':' + bind_props.root + ':ro');
                        }

                        _install(repo_tag_string, config, recreate, cb);
                    }
                });
            } else {
                _install(repo_tag_string, config, recreate, cb);
            }
        });
    } else {
        cb && cb(`No image available for "${docker_version.arch}" architecture`);
    }
}

ApiExtensionInstallerDocker.prototype.get_options_from_container = function(image, cb) {
    const name = _split(image.repo).repo;
    const container = docker.getContainer(name);

    container.inspect((err, info) => {
        if (info && info.Config.Image.split(':')[0] == image.repo) {
            let options = {};

            if (image.options) {
                if (image.options.env && info.Config.Env) {
                    if (!options.env) {
                        options.env = {};
                    }

                    for (const env_var in image.options.env) {
                        for (let i = 0; i < info.Config.Env.length; i++) {
                            if (info.Config.Env[i].includes(`${env_var}=`)) {
                                options.env[env_var] = info.Config.Env[i].split('=')[1];
                                break;
                            }
                        }
                    }
                }

                if (image.options.binds && info.HostConfig.Binds) {
                    if (!options.binds) {
                        options.binds = {};
                    }

                    for (let i = 0; i < image.options.binds.length; i++) {
                        const bind = image.options.binds[i].split(':')[0];

                        for (let j = 0; j < info.HostConfig.Binds.length; j++) {
                            const bind_split = info.HostConfig.Binds[j].split(':');

                            if (bind == bind_split[1]) {
                                options.binds[bind_split[0]] = bind_split[1];
                            }
                        }
                    }
                }

                if (image.options.devices && info.HostConfig.Devices) {
                    if (!options.devices) {
                        options.devices = {};
                    }

                    for (let i = 0; i < image.options.devices.length; i++) {
                        const device_split = image.options.devices[i].split(':');

                        if (device_split[0]) {
                            for (let j = 0; j < info.HostConfig.Devices.length; j++) {
                                const device_object = info.HostConfig.Devices[j];

                                if (device_split[0] == device_object.PathInContainer) {
                                    options.devices[device_object.PathOnHost] = device_object.PathInContainer;
                                }
                            }
                        } else {
                            console.error(`${name}: no default device specified for option ${device_split[1]}`);
                        }
                    }
                }
            }

            cb && cb(err, options);
        } else {
            cb && cb(err);
        }
    });
}

ApiExtensionInstallerDocker.prototype.uninstall = function(name, cb) {
    const container = docker.getContainer(name);

    container.inspect((err, info) => {
        if (info) {
            const image_name = info.Config.Image;

            container.remove((err) => {
                if (err) {
                    cb && cb(err);
                } else {
                    docker.getImage(image_name).remove((err) => {
                        if (err) {
                            cb && cb(err);
                        } else {
                            _query_installs(cb);
                        }
                    });
                }
            });
        } else {
            cb && cb(err);
        }
    });
}

ApiExtensionInstallerDocker.prototype.start = function(name, cb) {
    const container = docker.getContainer(name);

    container.start((err) => {
        if (!err) {
            container.inspect((err, info) => {
                if (info) {
                    states[name] = info.State.Status;

                    if (states[name] == 'running') {
                        started_at[name] = new Date(info.State.StartedAt).getTime();
                    }

                    container.update({ RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } });
                }

                cb && cb(err);
            });
        } else {
            cb && cb(err);
        }
    });
}

ApiExtensionInstallerDocker.prototype.stop = function(name, cb) {
    const container = docker.getContainer(name);

    container.stop({ t: 10 }, (err) => {
        container.inspect((err, info) => {
            if (info) {
                states[name] = info.State.Status;
            }

            if (states[name] != 'running') {
                delete started_at[name];
            }

            cb && cb();
        });
    });
}

ApiExtensionInstallerDocker.prototype.terminate = function(name, cb) {
    if (states[name] == 'running') {
        ApiExtensionInstallerDocker.prototype.stop.call(this, name, () => {
            if (states[name] == 'exited') {
                states[name] = 'terminated';
            }

            cb && cb();
        });
    } else {
        cb && cb();
    }
}

ApiExtensionInstallerDocker.prototype.get_log = function(name, path, cb) {
    const container = docker.getContainer(name);
    const options = {
        stdout:     true,
        stderr:     true,
        timestamps: true
    };

    container.logs(options, (err, buffer) => {
        if (Buffer.isBuffer(buffer)) {
            const fs = require('fs');
            let demux = buffer.slice();
            let demux_pos = 0;

            while (buffer.length >= 8) {
                const data_type = buffer.readUInt8(0);
                const data_length = buffer.readUInt32BE(4);

                buffer = buffer.slice(8);

                if ((data_type == 1 || data_type == 2) && buffer.length >= data_length) {
                    buffer.copy(demux, demux_pos, 0, data_length);

                    buffer = buffer.slice(data_length);
                    demux_pos += data_length;
                } else {
                    console.log('Demux failure:', data_type, data_length, buffer.length);
                    break;
                }
            }

            fs.writeFile(path, demux.slice(0, demux_pos), cb);
        } else {
            cb && cb(err);
        }
    });
}

function _get_volume(info, destination) {
    let volume;

    if (info && info.Mounts) {
        for (let i = 0; i < info.Mounts.length; i++) {
            if (destination.includes(info.Mounts[i].Destination)) {
                volume = {
                    source: info.Mounts[i].Source + '/',
                    name:   info.Mounts[i].Name
                };
                break;
            }
        }
    }

    return volume;
}

function _create_bind_path_and_file(config, bind_props, binds, count, cb) {
    // Check for an absolute path
    if (binds[count].indexOf('/') === 0) {
        const mkdirp = require('mkdirp');
        const fs = require('fs');
        const binds_path = bind_props.root + bind_props.binds_path;
        const full_path = binds_path + binds[count].substring(0, binds[count].lastIndexOf('/'));
        const full_name = binds_path + binds[count];
        const full_volume_name = (bind_props.volume ?
                                  bind_props.volume.source + bind_props.binds_path + binds[count] :
                                  full_name);

        // Create binds directory
        mkdirp(full_path, (err, made) => {
            if (err) {
                cb && cb(err);
            } else {
                config.Volumes[binds[count]] = {};
                config.HostConfig.Binds.push(full_volume_name + ':' + binds[count]);

                // Check if file already exists
                fs.open(full_name, 'r', (err, fd) => {
                    if (err) {
                        if (err.code == 'ENOENT') {
                            // Create empty file
                            fs.writeFile(full_name, '', (err) => {
                                if (err) {
                                    cb && cb(err);
                                } else {
                                    fs.chmodSync(full_name, 0o666);

                                    if (count) {
                                        _create_bind_path_and_file(config, bind_props, binds, count - 1, cb);
                                    } else {
                                        cb && cb();
                                    }
                                }
                            });
                        } else {
                            cb && cb(err);
                        }
                    } else {
                        fs.close(fd, (err) => {
                            if (count) {
                                _create_bind_path_and_file(config, bind_props, binds, count - 1, cb);
                            } else {
                                cb && cb();
                            }
                        });
                    }
                });
            }
        });
    } else if (count) {
        _create_bind_path_and_file(config, bind_props, binds, count - 1, cb);
    } else {
        cb && cb();
    }
}

function _install(repo_tag_string, config, recreate, cb) {
    docker.pull(repo_tag_string, (err, stream) => {
        if (err) {
            cb && cb(err);
        } else {
            let layer_status = {};
            docker.modem.followProgress(stream, on_finished, on_progress);

            function on_progress(event) {
                /*  {
                 *      status: 'Extracting',
                 *      progressDetail: { current: 9338880, total: 47926421 },
                 *      progress: '[=========>                                         ]  9.339MB/47.93MB',
                 *      id: '6a012575f640'
                 *  }
                 */
                if (event.progress) {
                    const status = event.status;
                    let progress;

                    progress = event.progress.split('] ');
                    progress = (progress.length > 1 ? progress[1].trim() : undefined);

                    const progress_split = progress.split('/');
                    if (progress_split[0] == progress_split[1]) {
                        delete layer_status[event.id];
                    } else {
                        layer_status[event.id] = { status, progress };
                    }
                } else if (layer_status[event.id]) {
                    delete layer_status[event.id];
                }

                if (Object.keys(layer_status).length) {
                    on_progress_cb && on_progress_cb(layer_status);
                }
            }

            function on_finished(err, output) {
                const final_status = output[output.length - 1].status;
                const up_to_date = (final_status == `Status: Image is up to date for ${repo_tag_string}`);
                const name = _split(repo_tag_string).repo;

                if (up_to_date && !recreate) {
                    cb && cb('already up to date');
                } else {
                    config.name  = name;
                    config.Image = repo_tag_string;

                    ApiExtensionInstallerDocker.prototype.terminate.call(this, name, () => {
                        if (installed[name]) {
                            const container = docker.getContainer(name);

                            container.remove((err) => {
                                if (err) {
                                    cb && cb(err);
                                } else {
                                    _create_container(config, cb);
                                }
                            });
                        } else {
                            _create_container(config, cb);
                        }
                    });
                }
            }
        }
    });
}

function _create_container(config, cb) {
    if (!config.HostConfig) {
        config.HostConfig = {};
    }

    // Container is created with restart policy off, this will be changed after the first start of the container
    // This prevents that the created container is started after a restart of the Docker daemon
    config.HostConfig.RestartPolicy = {
        Name: "",
        MaximumRetryCount: 0
    }

    // Other forced settings
    config.HostConfig.NetworkMode = "host";

    if (log_config) {
        config.HostConfig.LogConfig = log_config;
    }

    console.log(config);

    docker.createContainer(config, (err) => {
        if (err) {
            cb && cb(err);
        } else {
            _query_installs(cb, config.Image);
        }
    });
}

function _query_installs(cb, image_name) {
    const repo = (image_name ? _split(image_name).repo : undefined);
    let options = { all: true };

    if (repo) {
        options.filters = { name: [repo] };
    }

    docker.listContainers(options, (err, containers) => {
        if (err) {
            cb && cb(err);
        } else {
            let installs = {};

            containers.forEach((container) => {
                const name = container.Names[0].replace('/', '');

                installs[name] = _split(container.Image).tag;

                if (states[name] != 'terminated') {
                    states[name] = container.State.toLowerCase();
                }

                if (states[name] == 'running') {
                    const container = docker.getContainer(name);

                    container.inspect((err, info) => {
                        if (info) {
                            started_at[name] = new Date(info.State.StartedAt).getTime();
                        }
                    });
                }
            });

            if (image_name) {
                const name = Object.keys(installs);

                installed[name] = installs[name];

                cb && cb(err, installs[name]);
            } else {
                installed = installs;

                cb && cb(err, installed);
            }
        }
    });
}

function _split(repo_tag) {
    const fields = repo_tag.split(':');
    let repo = fields[0].split('/');
    let username;
    let tag;

    if (fields.length > 1) {
        tag = fields[1];
    }

    if (repo.length > 1) {
        username = repo[0];
        repo = repo[1];
    } else {
        repo = repo[0];
    }

    return {
        full_repo: fields[0],
        username : username,
        repo: repo,
        tag: tag
    };
}

exports = module.exports = ApiExtensionInstallerDocker;
