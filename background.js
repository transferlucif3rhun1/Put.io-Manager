importScripts('utils.js', 'logger.js');

const CONFIG = {
  API_BASE: 'https://api.put.io/v2',
  MAX_CONCURRENT: 2,
  REQUEST_TIMEOUT: 25000,
  PAGE_FETCH_TIMEOUT: 12000,
  MAX_PAGE_SIZE: 3 * 1024 * 1024,
  RETRY_ATTEMPTS: 1
};

let activeRequests = new Set();
let requestQueue = [];
let isProcessingQueue = false;
let contextMenuCreated = false;

const ErrorHandler = {
  log(context, error, data = {}) {
    Logger.error(context, error.message || error, { ...data, stack: error.stack });
    this.storeLastError(context, error);
  },
  
  async storeLastError(context, error) {
    try {
      await chrome.storage.local.set({
        lastError: {
          context,
          message: error.message || error,
          timestamp: Date.now()
        }
      });
    } catch (e) {}
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  try {
    Logger.info('Background', 'Extension installing');
    await ensureDomainsLoaded();
    await createContextMenu();
    Logger.info('Background', 'Installation completed');
  } catch (error) {
    ErrorHandler.log('Installation', error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    Logger.info('Background', 'Extension starting');
    await ensureDomainsLoaded();
    await createContextMenu();
  } catch (error) {
    ErrorHandler.log('Startup', error);
  }
});

async function createContextMenu() {
  try {
    if (contextMenuCreated) return;
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'sendToPutio',
      title: 'Send to Put.io',
      contexts: ['link'],
      documentUrlPatterns: ['https://*/*', 'http://*/*']
    });
    contextMenuCreated = true;
    Logger.info('Background', 'Context menu created');
  } catch (error) {
    ErrorHandler.log('ContextMenuCreate', error);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const startTime = Date.now();
  try {
    if (info.menuItemId !== 'sendToPutio' || !info.linkUrl || !tab?.url) {
      throw new Error('Invalid context menu state');
    }
    
    await ensureDomainsLoaded();
    
    const tabUrl = new URL(tab.url);
    if (!isWhitelistedDomain(tabUrl.hostname)) {
      sendNotificationToTab(tab.id, 'Domain not whitelisted', 'warning');
      Logger.warn('ContextMenu', 'Domain not whitelisted', { domain: tabUrl.hostname });
      return;
    }
    
    let magnetLink = extractMagnetFromUrl(info.linkUrl);
    
    if (!magnetLink) {
      try {
        magnetLink = await fetchMagnetFromPage(info.linkUrl);
      } catch (fetchError) {
        ErrorHandler.log('PageFetch', fetchError, { url: info.linkUrl });
        sendNotificationToTab(tab.id, 'Failed to fetch magnet link', 'error');
        return;
      }
    }
    
    if (!magnetLink) {
      sendNotificationToTab(tab.id, 'No magnet link found', 'warning');
      return;
    }
    
    const magnetHash = extractMagnetHash(magnetLink);
    if (!magnetHash) {
      sendNotificationToTab(tab.id, 'Invalid magnet format', 'error');
      return;
    }
    
    if (await isDuplicateMagnet(magnetHash)) {
      sendNotificationToTab(tab.id, 'Already submitted', 'warning');
      return;
    }
    
    const result = await sendWithRetry(() => sendToPutioAPI(magnetLink));
    
    if (result.success) {
      await markMagnetSubmitted(magnetHash);
      sendNotificationToTab(tab.id, 'Sent to Put.io successfully', 'success');
    } else {
      sendNotificationToTab(tab.id, result.error || 'Failed to send', 'error');
    }
    
    Logger.info('ContextMenu', 'Processing completed', { 
      success: result.success,
      duration: Date.now() - startTime 
    });
    
  } catch (error) {
    ErrorHandler.log('ContextMenu', error, { linkUrl: info.linkUrl });
    sendNotificationToTab(tab.id, 'Extension error occurred', 'error');
  }
});

async function fetchMagnetFromPage(url) {
  try {
    const urlObj = new URL(url);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      throw new Error('Invalid protocol');
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.PAGE_FETCH_TIMEOUT);
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > CONFIG.MAX_PAGE_SIZE) {
        throw new Error('Page too large');
      }
      
      const html = await response.text();
      const magnetLinks = extractMagnetLinksFromHtml(html);
      
      return magnetLinks.find(link => validateMagnetLink(link)) || null;
      
    } finally {
      clearTimeout(timeoutId);
    }
    
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

function extractMagnetLinksFromHtml(html) {
  try {
    const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^\s"<>]*/gi;
    const matches = html.match(magnetRegex) || [];
    return [...new Set(matches)];
  } catch (error) {
    ErrorHandler.log('HTMLParser', error);
    return [];
  }
}

async function isDuplicateMagnet(magnetHash) {
  try {
    const result = await chrome.storage.local.get(['transfers', 'retentionDays']);
    const transfers = result.transfers || {};
    const retentionDays = result.retentionDays || 7;
    const expirationTime = retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    if (transfers[magnetHash]) {
      if (now - transfers[magnetHash].timestamp < expirationTime) {
        return true;
      } else {
        delete transfers[magnetHash];
        await chrome.storage.local.set({ transfers });
      }
    }
    return false;
  } catch (error) {
    ErrorHandler.log('DuplicateCheck', error);
    return false;
  }
}

async function markMagnetSubmitted(magnetHash) {
  try {
    const result = await chrome.storage.local.get(['transfers']);
    const transfers = result.transfers || {};
    transfers[magnetHash] = { 
      timestamp: Date.now(),
      source: 'context_menu'
    };
    await chrome.storage.local.set({ transfers });
    return true;
  } catch (error) {
    ErrorHandler.log('MarkSubmitted', error);
    return false;
  }
}

async function sendWithRetry(operation, maxRetries = CONFIG.RETRY_ATTEMPTS) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isRetryableError(error)) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  return { success: false, error: lastError.message };
}

function isRetryableError(error) {
  const retryablePatterns = ['timeout', 'network', 'connection', 'ECONNRESET'];
  const errorMessage = (error.message || '').toLowerCase();
  return retryablePatterns.some(pattern => errorMessage.includes(pattern));
}

async function sendToPutioAPI(magnetLink) {
  try {
    if (!validateMagnetLink(magnetLink)) {
      throw new Error('Invalid magnet link');
    }

    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('API key not configured');
    }

    const cleanedMagnet = cleanMagnetLink(magnetLink);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    
    try {
      const response = await fetch(`${CONFIG.API_BASE}/transfers/add`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${apiKey}`
        },
        body: new URLSearchParams({
          url: cleanedMagnet,
          save_parent_id: 0
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = response.status === 401 ? 'Invalid API key' :
                           response.status === 429 ? 'Rate limit exceeded' :
                           response.status >= 500 ? 'Put.io server error' :
                           errorData.error_message || `HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      const data = await response.json();
      return { success: true, data };

    } finally {
      clearTimeout(timeoutId);
    }

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error('Network error');
    }
    throw error;
  }
}

async function getApiKey() {
  try {
    const result = await chrome.storage.local.get(['putioApiKey']);
    return result.putioApiKey || '';
  } catch (error) {
    ErrorHandler.log('GetApiKey', error);
    return '';
  }
}

function sendNotificationToTab(tabId, message, type) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    action: 'showNotification',
    message,
    type
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handleAsync = async () => {
    try {
      switch (request?.action) {
        case 'sendToPutio':
          if (!request.magnetLink) {
            throw new Error('No magnet link provided');
          }
          return await sendWithRetry(() => sendToPutioAPI(request.magnetLink));
          
        case 'updateWhitelist':
          const updateResult = await updateWhitelistedDomains(request.domains);
          if (updateResult) {
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: 'reloadWhitelist' }).catch(() => {});
              });
            });
          }
          return { success: updateResult };
          
        case 'getWhitelist':
          await ensureDomainsLoaded();
          return { success: true, domains: WHITELISTED_DOMAINS };
          
        case 'getLogs':
          const logs = await Logger.getLogs(request.level, request.component, request.limit);
          return { success: true, logs };
          
        case 'clearLogs':
          await Logger.clearLogs();
          return { success: true };
          
        default:
          throw new Error('Unknown action');
      }
    } catch (error) {
      ErrorHandler.log('MessageHandler', error, { action: request?.action });
      return { success: false, error: error.message };
    }
  };
  
  handleAsync().then(sendResponse).catch(error => {
    sendResponse({ success: false, error: error.message });
  });
  
  return true;
});

chrome.runtime.onSuspend.addListener(() => {
  activeRequests.clear();
  requestQueue.length = 0;
});

setInterval(async () => {
  try {
    const result = await chrome.storage.local.get(['transfers', 'retentionDays']);
    const transfers = result.transfers || {};
    const retentionDays = result.retentionDays || 7;
    const expirationTime = retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    let cleanedCount = 0;
    for (const [hash, data] of Object.entries(transfers)) {
      if (now - data.timestamp > expirationTime) {
        delete transfers[hash];
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      await chrome.storage.local.set({ transfers });
      Logger.info('Cleanup', `Cleaned ${cleanedCount} expired transfers`);
    }
  } catch (error) {
    ErrorHandler.log('Cleanup', error);
  }
}, 30 * 60 * 1000);