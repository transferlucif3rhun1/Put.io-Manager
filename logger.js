const Logger = {
  levels: {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
  },
  
  currentLevel: 2,
  maxLogs: 500,
  
  formatMessage(level, component, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] [${component}] ${message}`;
  },
  
  error(component, message, data = null) {
    if (this.currentLevel >= this.levels.ERROR) {
      const formattedMessage = this.formatMessage('ERROR', component, message);
      console.error(formattedMessage, data || '');
      this.saveLog('ERROR', component, message, data);
    }
  },
  
  warn(component, message, data = null) {
    if (this.currentLevel >= this.levels.WARN) {
      const formattedMessage = this.formatMessage('WARN', component, message);
      console.warn(formattedMessage, data || '');
      this.saveLog('WARN', component, message, data);
    }
  },
  
  info(component, message, data = null) {
    if (this.currentLevel >= this.levels.INFO) {
      const formattedMessage = this.formatMessage('INFO', component, message);
      console.info(formattedMessage, data || '');
      this.saveLog('INFO', component, message, data);
    }
  },
  
  debug(component, message, data = null) {
    if (this.currentLevel >= this.levels.DEBUG) {
      const formattedMessage = this.formatMessage('DEBUG', component, message);
      console.debug(formattedMessage, data || '');
      this.saveLog('DEBUG', component, message, data);
    }
  },
  
  async saveLog(level, component, message, data = null) {
    try {
      if (!this.isExtensionContextValid()) return;

      const logEntry = {
        timestamp: Date.now(),
        level,
        component,
        message,
        data: data ? this.stringifyData(data) : null,
        url: typeof window !== 'undefined' ? window.location.href : 'background'
      };
      
      const result = await chrome.storage.local.get(['extensionLogs']);
      let logs = result.extensionLogs || [];
      
      logs.push(logEntry);
      
      if (logs.length > this.maxLogs) {
        logs = logs.slice(-this.maxLogs);
      }
      
      await chrome.storage.local.set({ extensionLogs: logs });
    } catch (error) {
      if (error.message && error.message.includes('Extension context invalidated')) {
        return;
      }
    }
  },
  
  isExtensionContextValid() {
    try {
      return typeof chrome !== 'undefined' && 
             chrome.runtime && 
             chrome.runtime.id && 
             chrome.storage && 
             chrome.storage.local;
    } catch (error) {
      return false;
    }
  },
  
  stringifyData(data) {
    try {
      if (typeof data === 'string') return data;
      if (typeof data === 'object' && data !== null) {
        const stringified = JSON.stringify(data);
        return stringified.length > 500 ? stringified.substring(0, 500) + '...' : stringified;
      }
      return String(data);
    } catch (error) {
      return '[Circular or non-serializable data]';
    }
  },
  
  async getLogs(level = null, component = null, limit = 50) {
    try {
      if (!this.isExtensionContextValid()) return [];
      
      const result = await chrome.storage.local.get(['extensionLogs']);
      let logs = result.extensionLogs || [];
      
      if (level) {
        logs = logs.filter(log => log.level === level);
      }
      
      if (component) {
        logs = logs.filter(log => log.component === component);
      }
      
      return logs.slice(-limit).reverse();
    } catch (error) {
      console.error('Failed to get logs:', error);
      return [];
    }
  },
  
  async clearLogs() {
    try {
      if (!this.isExtensionContextValid()) {
        throw new Error('Extension context invalid');
      }
      
      await chrome.storage.local.remove(['extensionLogs']);
      this.info('Logger', 'Logs cleared successfully');
    } catch (error) {
      console.error('Failed to clear logs:', error);
      throw error;
    }
  },
  
  setLevel(level) {
    if (typeof level === 'string' && this.levels[level] !== undefined) {
      this.currentLevel = this.levels[level];
    } else if (typeof level === 'number' && level >= 0 && level <= 3) {
      this.currentLevel = level;
    } else {
      console.warn('Invalid log level:', level);
      return;
    }
    this.info('Logger', `Log level set to ${this.currentLevel}`);
  }
};

if (typeof window !== 'undefined') {
  window.Logger = Logger;
}

if (typeof setInterval !== 'undefined') {
  setInterval(async () => {
    try {
      if (!Logger.isExtensionContextValid()) return;
      
      const result = await chrome.storage.local.get(['extensionLogs']);
      const logs = result.extensionLogs || [];
      
      if (logs.length > Logger.maxLogs) {
        const trimmedLogs = logs.slice(-Logger.maxLogs);
        await chrome.storage.local.set({ extensionLogs: trimmedLogs });
        Logger.info('Logger', `Auto-trimmed logs to ${Logger.maxLogs} entries`);
      }
    } catch (error) {
      if (!error.message || !error.message.includes('Extension context invalidated')) {
        console.warn('Log cleanup failed:', error.message);
      }
    }
  }, 30 * 60 * 1000);
}