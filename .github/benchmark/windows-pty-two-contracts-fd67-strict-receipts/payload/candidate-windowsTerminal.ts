/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import { Socket } from 'net';
import { Terminal, DEFAULT_COLS, DEFAULT_ROWS } from './terminal';
import { WindowsPtyAgent } from './windowsPtyAgent';
import { IPtyOpenOptions, IWindowsPtyForkOptions } from './interfaces';
import { ArgvOrCommandLine } from './types';
import { assign } from './utils';

const DEFAULT_FILE = 'cmd.exe';
const DEFAULT_NAME = 'Windows Shell';

export class WindowsTerminal extends Terminal {
  private _isReady: boolean;
  private _killRequested: boolean;
  private _killComplete: boolean;
  private _isPipeReady: boolean;
  private _deferreds: { run: () => void }[];
  private _agent: WindowsPtyAgent;

  constructor(file?: string, args?: ArgvOrCommandLine, opt?: IWindowsPtyForkOptions) {
    super(opt);

    this._checkType('args', args, 'string', true);

    // Initialize arguments
    args = args || [];
    file = file || DEFAULT_FILE;
    opt = opt || {};
    opt.env = opt.env || process.env;

    if (opt.encoding) {
      console.warn('Setting encoding on Windows is not supported');
    }

    const env = assign({}, opt.env);
    this._cols = opt.cols || DEFAULT_COLS;
    this._rows = opt.rows || DEFAULT_ROWS;
    const cwd = opt.cwd || process.cwd();
    const name = opt.name || env.TERM || DEFAULT_NAME;
    const parsedEnv = this._parseEnv(env);

    // If the terminal is ready
    this._isReady = false;
    this._killRequested = false;
    this._killComplete = false;
    this._isPipeReady = false;

    // Functions that need to run after `ready` event is emitted.
    this._deferreds = [];

    // Create new termal.
    this._agent = new WindowsPtyAgent(file, args, parsedEnv, cwd, this._cols, this._rows, false, opt.useConpty, opt.useConptyDll, opt.conptyInheritCursor);
    this._socket = this._agent.outSocket;

    // Attach before readiness so a broken ConPTY output pipe cannot be unhandled.
    this._socket.on('error', err => {
      const code = (<any>err).code;

      // PTY output can report EPIPE before `_close()` wins the race.
      this._close();
      if (code === 'EPIPE' || code === 'ERR_STREAM_PUSH_AFTER_EOF' || code === 'ERR_STREAM_DESTROYED') {
        return;
      }

      // EIO, happens when someone closes our child process: the only process
      // in the terminal.
      // node < 0.6.14: errno 5
      // node >= 0.6.14: read EIO
      if (typeof code === 'string') {
        if (~code.indexOf('errno 5') || ~code.indexOf('EIO')) return;
      }

      // Throw anything else.
      if (this.listeners('error').length < 2) {
        throw err;
      }
    });

    // Not available until `ready` event emitted.
    this._pid = this._agent.innerPid;
    this._fd = this._agent.fd;
    this._pty = this._agent.pty;

    // A pre-output teardown must still publish the actual pipe close.
    this._socket.once('close', () => {
      if (this._isPipeReady) {
        this.emit('exit', this._agent.exitCode);
      }
      this._close();
    });

    // The forked windows terminal is not available until `ready` event is
    // emitted.
    this._socket.on('ready_datapipe', () => {
      this._isPipeReady = true;
      if (this._killRequested) {
        this.kill();
        return;
      }

      // Run deferreds and set ready state once the first data event is received.
      this._socket.once('data', () => {
        // Wait until the first data event is fired then we can run deferreds.
        if (!this._isReady && !this._killRequested) {
          // Terminal is now ready and we can avoid having to defer method
          // calls.
          this._isReady = true;

          // Execute all deferred methods
          this._deferreds.forEach(fn => {
            // NB! In order to ensure that `this` has all its references
            // updated any variable that need to be available in `this` before
            // the deferred is run has to be declared above this forEach
            // statement.
            fn.run();
          });

          // Reset
          this._deferreds = [];
        }
      });


    });

    this._file = file;
    this._name = name;

    this._readable = true;
    this._writable = true;
    // A ConPTY input-pipe error must retire only this terminal. Without a listener, Node promotes
    // errors such as write EAGAIN to uncaughtException and kills every PTY in the daemon.
    this._agent.inSocket.on('error', () => {
      if (!this._writable) {
        return;
      }
      this._close();
      try {
        this._agent.kill();
      } catch {
        // The failing pipe may have raced process exit; the terminal is already unwritable.
      }
    });

    this._forwardEvents();
  }

  protected _write(data: string | Buffer): void {
    this._defer(this._doWrite, data);
  }

  private _doWrite(data: string | Buffer): void {
    this._agent.inSocket.write(data);
  }

  /**
   * openpty
   */

  public static open(options?: IPtyOpenOptions): void {
    throw new Error('open() not supported on windows, use Fork() instead.');
  }

  /**
   * TTY
   */

  public resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0 || isNaN(cols) || isNaN(rows) || cols === Infinity || rows === Infinity) {
      throw new Error('resizing must be done using positive cols and rows');
    }
    this._deferNoArgs(() => {
      this._agent.resize(cols, rows);
      this._cols = cols;
      this._rows = rows;
    });
  }

  public clear(): void {
    this._deferNoArgs(() => {
      this._agent.clear();
    });
  }

  public destroy(): void {
    this.kill();
  }

  public kill(signal?: string): void {
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
  }

  private _deferNoArgs<A>(deferredFn: () => void): void {
    if (this._killRequested) {
      return;
    }
    // If the terminal is ready, execute.
    if (this._isReady) {
      deferredFn.call(this);
      return;
    }

    // Queue until terminal is ready.
    this._deferreds.push({
      run: () => deferredFn.call(this)
    });
  }

  private _defer<A>(deferredFn: (arg: A) => void, arg: A): void {
    if (this._killRequested) {
      return;
    }
    // If the terminal is ready, execute.
    if (this._isReady) {
      deferredFn.call(this, arg);
      return;
    }

    // Queue until terminal is ready.
    this._deferreds.push({
      run: () => deferredFn.call(this, arg)
    });
  }

  public get process(): string { return this._name; }
  public get master(): Socket { throw new Error('master is not supported on Windows'); }
  public get slave(): Socket { throw new Error('slave is not supported on Windows'); }
}
