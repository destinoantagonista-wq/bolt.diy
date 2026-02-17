import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('stream-recovery');

export interface StreamRecoveryOptions {
  maxRetries?: number;
  timeout?: number;
  onTimeout?: () => void;
  onRecovery?: () => void;
  onRetry?: (attempt: number, maxRetries: number) => void;
  onExhausted?: () => void;
}

export class StreamRecoveryManager {
  private _retryCount = 0;
  private _timeoutHandle: NodeJS.Timeout | null = null;
  private _lastActivity: number = Date.now();
  private _isActive = false;

  constructor(private _options: StreamRecoveryOptions = {}) {
    this._options = {
      maxRetries: 3,
      timeout: 30000, // 30 seconds default
      ..._options,
    };
  }

  startMonitoring() {
    this._isActive = true;
    this._retryCount = 0;
    this._lastActivity = Date.now();
    this._resetTimeout();
  }

  updateActivity() {
    this._lastActivity = Date.now();
    this._resetTimeout();
  }

  private _resetTimeout() {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
    }

    if (!this._isActive) {
      return;
    }

    this._timeoutHandle = setTimeout(() => {
      if (this._isActive) {
        logger.warn('Stream timeout detected');
        this._handleTimeout();
      }
    }, this._options.timeout);
  }

  private _handleTimeout() {
    const maxRetries = this._options.maxRetries || 3;

    if (this._retryCount >= maxRetries) {
      logger.error('Max retries reached for stream recovery');

      if (this._options.onExhausted) {
        this._options.onExhausted();
      }

      this.stop();

      return;
    }

    this._retryCount++;
    logger.info(`Attempting stream recovery (attempt ${this._retryCount}/${maxRetries})`);

    if (this._options.onRetry) {
      this._options.onRetry(this._retryCount, maxRetries);
    }

    if (this._options.onTimeout) {
      this._options.onTimeout();
    }

    // Reset monitoring after recovery attempt
    this._resetTimeout();

    if (this._options.onRecovery) {
      this._options.onRecovery();
    }
  }

  stop() {
    this._isActive = false;

    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  getStatus() {
    return {
      isActive: this._isActive,
      retryCount: this._retryCount,
      lastActivity: this._lastActivity,
      timeSinceLastActivity: Date.now() - this._lastActivity,
    };
  }
}
