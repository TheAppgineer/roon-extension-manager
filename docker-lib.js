// Copyright 2019 - 2021 The Appgineer
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

function ApiExtensionInstallerDocker(cb) {
    docker = new Docker({ socketPath: '/var/run/docker.sock' });

    docker.version((err, version) => {
        if (!err && version.Version) {
            if (version.Os == 'linux') {
                docker_version = version;

                _query_installs((err, installed) => {
                    cb && cb(err, installed);
                });
            } else {
                cb && cb('Host OS not supported: ' + version.Os);
            }
        } else {
            cb && cb('Docker not found');
        }
    });
}

ApiExtensionInstallerDocker.prototype.get_status = function(name) {
    let version;
    let tag;
    let state;

    if (name) {
        tag = installed[name];
    } else if (docker_version) {
        version = docker_version.Version;
    }

    state = (tag ? 'installed' : 'not_installed');

    if (state == 'installed') {
        // Get container state
        state = states[name];

        if (state == 'created' || state == 'exited') {
            // Convert Docker specific states to generic stopped state
            state = 'stopped';
        }
    }

    return {
        state:   state,
        version: version,
        tag:     tag,
        logging: undefined
    };
}

ApiExtensionInstallerDocker.prototype.get_name = function(image) {
    return _split(image.repo).repo;
}

ApiExtensionInstallerDocker.prototype.get_install_options = function(image) {

    return (image && image.options ? image.options : undefined);
}

ApiExtensionInstallerDocker.prototype.install = function(image, bind_props, options, cb) {
    if (docker_version && image && image.tags[docker_version.Arch]) {
        const repo_tag_string = image.repo + ':' + image.tags[docker_version.Arch];
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

        // Process binds
        if (image.binds && image.binds.length && bind_props) {
            if (!config.Volumes) {
                config.Volumes = {};
            }
            if (!config.HostConfig) {
                config.HostConfig = {};
            }
            if (!config.HostConfig.Binds) {
                config.HostConfig.Binds = [];
            }

            _get_volume(bind_props.name, bind_props.root, (volume) => {
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

                        _install(repo_tag_string, config, cb);
                    }
                });
            });
        } else {
            _install(repo_tag_string, config, cb);
        }
    } else {
        cb && cb('No image available for "' + docker_version.Arch + '" architecture');
    }
}

ApiExtensionInstallerDocker.prototype.query_updates = function(cb, name) {
    if (name) {
        let updates = {};

        if (installed[name]) {
            updates[name] = installed[name];
        }

        cb && cb(updates);
    } else {
        cb && cb(installed);
    }
}

ApiExtensionInstallerDocker.prototype.update = function(name, cb) {
    const container = docker.getContainer(name);

    container.inspect((err, info) => {
        if (info) {
            const image_name = info.Config.Image;
            let config = info.Config;
            config.HostConfig = info.HostConfig;

            _install(image_name, config, cb);
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

ApiExtensionInstallerDocker.prototype.start = function(name, fd) {
    const container = docker.getContainer(name);

    container.start((err) => {
        container.inspect((err, info) => {
            if (info) {
                states[name] = info.State.Status;
                container.update({ RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } });

                ApiExtensionInstallerDocker.prototype.log.call(this, name, fd);
            }
        });
    });
}

ApiExtensionInstallerDocker.prototype.stop = function(name, cb) {
    const container = docker.getContainer(name);

    container.stop((err) => {
        container.inspect((err, info) => {
            if (info) {
                states[name] = info.State.Status;
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

ApiExtensionInstallerDocker.prototype.log = function(name, fd) {
    const container = docker.getContainer(name);
    const options = {
        follow: true,
        stdout: true,
        stderr: true,
        since:  Date.now() / 1000
    };

    fd && container.logs(options, (err, stream) => {
        if (stream && stream.statusCode == 200) {
            const fs = require('fs');
            let log_stream = fs.createWriteStream(undefined, {fd: fd});

            container.modem.demuxStream(stream, log_stream, log_stream);
        }
    });
}

function _get_volume(name, destination, cb) {
    const container = docker.getContainer(name);

    container.inspect((err, info) => {
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

        cb && cb(volume);
    });
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

function _install(repo_tag_string, config, cb) {
    docker.pull(repo_tag_string, (err, stream) => {
        if (err) {
            cb && cb(err);
        } else {
            docker.modem.followProgress(stream, /* onFinished */ (err, output) => {
                const final_status = output[output.length - 1].status;
                const name = _split(repo_tag_string).repo;

                if (installed[name] && final_status.includes('Status: Image is up to date')) {
                    console.log(final_status);
                    _query_installs(cb, repo_tag_string);
                } else {
                    config.name  = name;
                    config.Image = repo_tag_string;

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
                }
            });
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
