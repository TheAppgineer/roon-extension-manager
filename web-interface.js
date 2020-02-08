// Copyright 2020 The Appgineer
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

const express = require('express');

const SETTINGS_PATH = "/settings";

var api_object;
var settings;
var io;
var curr_status = {};
var curr_actions;

function WebInterface(port, callbacks) {
    const app = express();
    const server = require('http').createServer(app);

    io = require('socket.io')(server);

    app.use(express.json());
    app.use(express.urlencoded({ extended: false}));
    app.use(express.static('public'));

    app.get('/', (req, res) => {
        const title = 'Roon Extensions';
        let page_layout = `<h2 class="text-center mb-5">${title}</h2>\n`;

        // Drop local settings as the settings page was left
        settings = undefined;

        page_layout += '<div class="row">\n';
        page_layout += '<div class="col">\n';

        if (callbacks.get_api_object) {
            api_object = callbacks.get_api_object();

            const info = api_object.extension_reginfo;

            page_layout += `<h5 class="text">${info.publisher}</h5>\n`;
            page_layout += `<h6><a href="${info.website}" class="text">${info.display_name}</a>\n`;
            page_layout += `<font class="text">${info.display_version}</font></h6>\n`;
        }

        page_layout += '</div>\n';
        page_layout += '<div class="col">\n';
        page_layout += '<a href="/settings" class="btn btn-primary float-right">Settings</a>\n';
        page_layout += '</div>\n';
        page_layout += '</div>\n';
        page_layout += '<div class="row">\n';
        page_layout += '<div class="col">\n';
        page_layout += `<h6 class="text" id ="status_id"></h6>\n`;
        page_layout += '</div>\n';
        page_layout += '<div class="col">\n';
        page_layout += '<a href="/extensions.log" class="btn btn-light float-right">Download Log Files</a>\n';
        page_layout += '</div>\n';
        page_layout += '</div>\n';
        page_layout += '<script src="/socket.io/socket.io.js"></script>\n';
        page_layout += '<script src="status.js"></script>\n';

        res.send(_get_page(title, page_layout));
    });

    app.get(SETTINGS_PATH, (req, res) => {
        if (callbacks.get_api_object) {
            api_object = callbacks.get_api_object();

            const title = 'Extension Settings';
            const info = api_object.extension_reginfo;
            let page_layout = '';

            if (settings === undefined && callbacks.get_settings) {
                settings = callbacks.get_settings();

                // Work with a values clone
                let values = {};

                for (const key in settings.values) {
                    values[key] = settings.values[key];
                }

                settings.values = values;
            }

            page_layout += `<h2 class="text-center mb-3">${title}</h2>\n`;
            page_layout += `<h5><font class="text mb-3">${info.display_name} ${info.display_version}</font></h5>\n`;
            page_layout += `<form action="${SETTINGS_PATH}" method="POST">\n`;
            page_layout += _render_layout(settings.layout);
            page_layout += '<a href="/" class="btn btn-light float-right mt-3 ml-3">Cancel</a>\n';
            page_layout += '<input type="submit" name="apply" value="Save" class="btn btn-primary float-right mt-3">\n';
            page_layout += '</form>\n';
            page_layout += '<script src="/socket.io/socket.io.js"></script>\n';
            page_layout += '<script src="actions.js"></script>\n';

            res.send(_get_page(title, page_layout));
        }
    });

    app.post(SETTINGS_PATH, (req, res) => {
        if (settings) {
            for (const key in req.body) {
                if (key != 'apply') {
                    settings.values[key] = req.body[key];
                }
            }

            if (callbacks.save_settings) {
                settings = callbacks.save_settings(undefined, req.body.apply != 'Save', settings);
            }
        }

        res.status(200);

        if (req.body.apply) {
            res.redirect('/');
        } else {
            res.redirect('back');
        }
    });

    app.get('/extensions.log', (req, res) => {
        callbacks.get_logs_archive && callbacks.get_logs_archive(res);
    });
    
    io.on('connection', (socket) => {
        // Send current status at first connect
        socket.emit('status', curr_status);
        socket.emit('actions', curr_actions);
    });
    
    server.listen(port);
}

WebInterface.prototype.update_status = function(message, is_error) {
    curr_status.message = message;
    curr_status.is_error = is_error;

    // Send status to all clients
    io.sockets.emit('status', curr_status);
}

WebInterface.prototype.update_actions = function(actions) {
    curr_actions = actions;

    // Send actions to all clients
    io.sockets.emit('actions', actions);
}

function _get_page(title, body) {
    return (
        '<html lang="en">\n' +
        '<head>\n' +
        '<link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.4.1/css/bootstrap.min.css" ' +
        'integrity="sha384-Vkoo8x4CGsO3+Hhxv8T/Q5PaXtkKtu6ug5TOeNV6gBiFeWPGFN9MuhOf23Q9Ifjh" crossorigin="anonymous">\n' +
        '<link rel="shortcut icon" href="favicon.ico" type="image/x-icon">\n' +
        '<link rel="icon" href="favicon.ico" type="image/x-icon">\n' +
        `<title>${title}</title>\n` +
        '</head>\n' +
        '<body>\n' +
        '<div class="container mt-2">\n' +
        '<div><small>\n' +
        '<a href="https://github.com/TheAppgineer/roon-extension-manager/wiki#roon-extension-manager" class="text float-right">Roon Extension Manager Wiki</a><br>' +
        '</small></div>\n' +
        body +
        '</div>\n' +
        '</body>\n' +
        '</html>\n'
    );
};

function _render_layout(layout) {
    let page_layout = '';

    for (let i = 0; i < layout.length; i++) {
        switch (layout[i].type) {
            case 'group':
                page_layout += `<h5 class="mt-3">${layout[i].title}</h5>\n`;
                page_layout += '<div class="form-group">\n';
                page_layout += _render_layout(layout[i].items);
                page_layout += '</div>\n';
                break;
            case 'string':
                page_layout += _render_string(layout[i]);
                break;
            case 'dropdown':
                page_layout += _render_dropdown(layout[i]);
                break;
            case 'label':
                page_layout += _render_label(layout[i]);
                break;
        }
    }

    return page_layout;
}

function _render_string(str) {
    let page_layout = '';

    if (str.setting) {
        const state = (str.error ? 'is-invalid' : '');
        const value = (settings.values[str.setting] ? settings.values[str.setting] : '');

        page_layout += '<div class="row mb-2">\n';
        page_layout += '<div class="col">\n';
        page_layout += `<label class="form-check-label" for="${str.setting}_id">${str.title}</label>\n`;
        page_layout += '</div>\n';
        page_layout += '<div class="col">\n';
        page_layout += `<input type="text" onchange="this.form.submit()" name="${str.setting}" value="${value}" class="form-control ${state}" id ="${str.setting}_id">\n`;
        page_layout += `<div class="invalid-feedback">${str.error}</div>\n`;
        page_layout += '</div>\n';
        page_layout += '</div>\n';
    }
    
    return page_layout;
}

function _render_dropdown(drpdwn) {
    let page_layout = '';

    if (drpdwn.setting) {
        page_layout += '<div class="row mb-2">\n';
        page_layout += '<div class="col">\n';
        page_layout += `<label class="form-check-label" for="${drpdwn.setting}_id">${drpdwn.title}</label>\n`;
        page_layout += '</div>\n';
        page_layout += '<div class="col">\n';
        page_layout += `<select onchange="this.form.submit()" name="${drpdwn.setting}" class="form-control" id ="${drpdwn.setting}_id">\n`

        for (let i = 0; i < drpdwn.values.length; i++) {
            if (drpdwn.values[i].value === settings.values[drpdwn.setting]) {
                page_layout += `<option value="${drpdwn.values[i].value}" selected>${drpdwn.values[i].title}</option>\n`
            } else {
                page_layout += `<option value="${drpdwn.values[i].value}">${drpdwn.values[i].title}</option>\n`
            }
        }

        page_layout += `</select>\n`;
        page_layout += '</div>\n';
        page_layout += '</div>\n';
    }
    
    return page_layout;
}

function _render_label(lbl) {
    let lines = lbl.title.split('\n');
    let page_layout = '';

    for (let i = 0; i < lines.length; i++) {
        page_layout += `<label class="" style="white-space: pre-wrap">${lines[i]}</label><br>\n`;
    }
    
    return page_layout;
}

module.exports = WebInterface;
