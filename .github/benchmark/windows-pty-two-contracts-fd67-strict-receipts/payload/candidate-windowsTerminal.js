"use strict";
/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowsTerminal = void 0;
var terminal_1 = require("./terminal");
var windowsPtyAgent_1 = require("./windowsPtyAgent");
var utils_1 = require("./utils");
var DEFAULT_FILE = 'cmd.exe';
var DEFAULT_NAME = 'Windows Shell';
var WindowsTerminal = /** @class */ (function (_super) {
    __extends(WindowsTerminal, _super);
    function WindowsTerminal(file, args, opt) {
        var _this = _super.call(this, opt) || this;
        _this._checkType('args', args, 'string', true);
        // Initialize arguments
        args = args || [];
        file = file || DEFAULT_FILE;
        opt = opt || {};
        opt.env = opt.env || process.env;
        if (opt.encoding) {
            console.warn('Setting encoding on Windows is not supported');
        }
        var env = utils_1.assign({}, opt.env);
        _this._cols = opt.cols || terminal_1.DEFAULT_COLS;
        _this._rows = opt.rows || terminal_1.DEFAULT_ROWS;
        var cwd = opt.cwd || process.cwd();
        var name = opt.name || env.TERM || DEFAULT_NAME;
        var parsedEnv = _this._parseEnv(env);
        // If the terminal is ready
        _this._isReady = false;
        _this._killRequested = false;
        _this._killComplete = false;
        _this._isPipeReady = false;
        // Functions that need to run after `ready` event is emitted.
        _this._deferreds = [];
        // Create new termal.
        _this._agent = new windowsPtyAgent_1.WindowsPtyAgent(file, args, parsedEnv, cwd, _this._cols, _this._rows, false, opt.useConpty, opt.useConptyDll, opt.conptyInheritCursor);
        _this._socket = _this._agent.outSocket;
        // Attach before readiness so a broken ConPTY output pipe cannot be unhandled.
        _this._socket.on('error', function (err) {
            var code = err && err.code;
            // PTY output can report EPIPE before `_close()` wins the race.
            _this._close();
            if (code === 'EPIPE' || code === 'ERR_STREAM_PUSH_AFTER_EOF' || code === 'ERR_STREAM_DESTROYED') {
                return;
            }
            // EIO, happens when someone closes our child process: the only process
            // in the terminal.
            // node < 0.6.14: errno 5
            // node >= 0.6.14: read EIO
            if (typeof code === 'string') {
                if (~code.indexOf('errno 5') || ~code.indexOf('EIO'))
                    return;
            }
            // Throw anything else.
            if (_this.listeners('error').length < 2) {
                throw err;
            }
        });
        // Not available until `ready` event emitted.
        _this._pid = _this._agent.innerPid;
        _this._fd = _this._agent.fd;
        _this._pty = _this._agent.pty;
        // A pre-output teardown must still publish the actual pipe close.
        _this._socket.once('close', function () {
            if (_this._isPipeReady) {
                _this.emit('exit', _this._agent.exitCode);
            }
            _this._close();
        });
        // The forked windows terminal is not available until `ready` event is
        // emitted.
        _this._socket.on('ready_datapipe', function () {
            _this._isPipeReady = true;
            if (_this._killRequested) {
                _this.kill();
                return;
            }
            // Run deferreds and set ready state once the first data event is received.
            _this._socket.once('data', function () {
                // Wait until the first data event is fired then we can run deferreds.
                if (!_this._isReady && !_this._killRequested) {
                    // Terminal is now ready and we can avoid having to defer method
                    // calls.
                    _this._isReady = true;
                    // Execute all deferred methods
                    _this._deferreds.forEach(function (fn) {
                        // NB! In order to ensure that `this` has all its references
                        // updated any variable that need to be available in `this` before
                        // the deferred is run has to be declared above this forEach
                        // statement.
                        fn.run();
                    });
                    // Reset
                    _this._deferreds = [];
                }
            });
        });
        _this._file = file;
        _this._name = name;
        _this._readable = true;
        _this._writable = true;
        // A ConPTY input-pipe error must retire only this terminal. Without a listener, Node promotes
        // errors such as write EAGAIN to uncaughtException and kills every PTY in the daemon.
        _this._agent.inSocket.on('error', function () {
            if (!_this._writable) {
                return;
            }
            _this._close();
            try {
                _this._agent.kill();
            }
            catch (_a) {
                // The failing pipe may have raced process exit; the terminal is already unwritable.
            }
        });
        _this._forwardEvents();
        return _this;
    }
    WindowsTerminal.prototype._write = function (data) {
        this._defer(this._doWrite, data);
    };
    WindowsTerminal.prototype._doWrite = function (data) {
        this._agent.inSocket.write(data);
    };
    /**
     * openpty
     */
    WindowsTerminal.open = function (options) {
        throw new Error('open() not supported on windows, use Fork() instead.');
    };
    /**
     * TTY
     */
    WindowsTerminal.prototype.resize = function (cols, rows) {
        var _this = this;
        if (cols <= 0 || rows <= 0 || isNaN(cols) || isNaN(rows) || cols === Infinity || rows === Infinity) {
            throw new Error('resizing must be done using positive cols and rows');
        }
        this._deferNoArgs(function () {
            _this._agent.resize(cols, rows);
            _this._cols = cols;
            _this._rows = rows;
        });
    };
    WindowsTerminal.prototype.clear = function () {
        var _this = this;
        this._deferNoArgs(function () {
            _this._agent.clear();
        });
    };
    WindowsTerminal.prototype.destroy = function () {
        this.kill();
    };
    WindowsTerminal.prototype.kill = function (signal) {
        if (signal) {
            throw new Error('Signals not supported on windows.');
        }
        // Retire input now; native close requires the forwarding pipe, not first output.
        this._killRequested = true;
        this._deferreds = [];
        this._close();
        if (!this._isPipeReady || this._killComplete) {
            return;
        }
        this._agent.kill();
        this._killComplete = true;
    };
    WindowsTerminal.prototype._deferNoArgs = function (deferredFn) {
        if (this._killRequested) {
            return;
        }
        var _this = this;
        // If the terminal is ready, execute.
        if (this._isReady) {
            deferredFn.call(this);
            return;
        }
        // Queue until terminal is ready.
        this._deferreds.push({
            run: function () { return deferredFn.call(_this); }
        });
    };
    WindowsTerminal.prototype._defer = function (deferredFn, arg) {
        if (this._killRequested) {
            return;
        }
        var _this = this;
        // If the terminal is ready, execute.
        if (this._isReady) {
            deferredFn.call(this, arg);
            return;
        }
        // Queue until terminal is ready.
        this._deferreds.push({
            run: function () { return deferredFn.call(_this, arg); }
        });
    };
    Object.defineProperty(WindowsTerminal.prototype, "process", {
        get: function () { return this._name; },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(WindowsTerminal.prototype, "master", {
        get: function () { throw new Error('master is not supported on Windows'); },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(WindowsTerminal.prototype, "slave", {
        get: function () { throw new Error('slave is not supported on Windows'); },
        enumerable: false,
        configurable: true
    });
    return WindowsTerminal;
}(terminal_1.Terminal));
exports.WindowsTerminal = WindowsTerminal;
//# sourceMappingURL=windowsTerminal.js.map
