// Copyright 2021 The Appgineer
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

var token;
var user;
var starred_repos = {};

function ApiDockerHub() {
}

ApiDockerHub.prototype.login = function(username, password, cb) {
    _send_request('POST', '/v2/users/login/', { username, password }, (status_code, body) => {
        if (status_code === 200 && body.token) {
            user = username;
            token = body.token;

            cb && cb();
        } else {
            cb && cb(status_code, body && body.detail);
        }
    });
}

ApiDockerHub.prototype.logout = function(cb) {
    if (token) {
        _send_request('POST', '/v2/logout/', {}, (status_code, body) => {
            token = undefined;
            user = undefined;

            cb && cb(status_code, body && body.detail);
        });
    } else {
        cb && cb();
    }
}

ApiDockerHub.prototype.get_stats = function(repo, cb) {
    _send_request('GET', `/v2/repositories/${repo}/`, undefined, (status_code, body) => {
        if (body) {
            let stats = {};

            stats.pull_count = body.pull_count;

            _get_star_givers(repo, (star_givers) => {
                if (star_givers) {
                    stats.star_count = star_givers.length;
                    stats.starred = starred_repos[repo];
                }

                cb && cb(stats);
            });
        } else {
            cb && cb();
        }
    });
}

ApiDockerHub.prototype.star = function(repo, cb) {
    _send_request('POST', `/v2/repositories/${repo}/stars/`, {}, (status_code, body) => {
        cb && cb(status_code, body && body.detail);
    });
}

ApiDockerHub.prototype.unstar = function(repo, cb) {
    _send_request('DELETE', `/v2/repositories/${repo}/stars/`, {}, (status_code, body) => {
        cb && cb(status_code, body && body.detail);
    });
}

function _get_star_givers(repo, cb) {
    _send_request('GET', `/v2/repositories/${repo}/stars/`, undefined, (status_code, body) => {
        if (body) {
            const star_givers = body.list

            if (user) {
                starred_repos[repo] = star_givers.includes(user);
            } else {
                delete starred_repos[repo];
            }

            cb && cb(star_givers);
        } else {
            cb && cb();
        }
    });
}

function _send_request(method, path, data, cb) {
    const https = require('https');
    let options = {
        host: 'hub.docker.com',
        path,
        method,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    if (token || path.includes('login')) {
        options.headers.Authorization = `JWT ${token}`;
    } else if (method != 'GET') {
        cb && cb();

        return;
    }

    const req = https.request(options, (response) => {
        let body = '';

        response.on('data', (data) => {
            body += data;
        });
        response.on('end', () => {
            if (body.length) {
                cb && cb(response.statusCode, JSON.parse(body));
            } else {
                cb && cb(response.statusCode);
            }
        });
    });

    req.on('error', (err) => {
        console.error(err);
    });

    if (data) {
        req.write(JSON.stringify(data));
    }

    req.end();
}

exports = module.exports = ApiDockerHub;
