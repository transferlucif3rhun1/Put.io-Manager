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
    const errorMessage = error?.message || error || 'Unknown error';
    const errorData = { ...data, stack: error?.stack };
    Logger.error(context, errorMessage, errorData);
    this.storeLastError(context, error);
    console.error(`[Put.io Extension] ${context}:`, errorMessage, errorData);
  },
  
  async storeLastError(context, error) {
    try {
      await chrome.storage.local.set({
        lastError: {
          context,
          message: error?.message || error || 'Unknown error',
          timestamp: Date.now()
        }
      });
    } catch (e) {
      console.error('Failed to store error:', e);
    }
  }
};

// Initialize extension
chrome.runtime.onInstalled.addListener(async () => {
  try {
    console.log('[Put.io Extension] Installing...');
    Logger.info('Background', 'Extension installing');
    await ensureDomainsLoaded();
    await createContextMenus();
    Logger.info('Background', 'Installation completed');
    console.log('[Put.io Extension] Installation completed');
  } catch (error) {
    ErrorHandler.log('Installation', error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    console.log('[Put.io Extension] Starting up...');
    Logger.info('Background', 'Extension starting');
    await ensureDomainsLoaded();
    await createContextMenus();
    Logger.info('Background', 'Startup completed');
  } catch (error) {
    ErrorHandler.log('Startup', error);
  }
});

async function createContextMenus() {
  try {
    if (contextMenuCreated) {
      console.log('[Put.io Extension] Context menus already created');
      return;
    }
    
    console.log('[Put.io Extension] Creating context menus...');
    
    // Remove all existing context menus first
    await chrome.contextMenus.removeAll();
    
    // Create main context menu for links and selections
    await chrome.contextMenus.create({
      id: 'sendToPutio',
      title: 'Send to Put.io',
      contexts: ['link', 'selection'],
      documentUrlPatterns: ['https://*/*', 'http://*/*']
    });
    
    // Create page context menu for debugging
    await chrome.contextMenus.create({
      id: 'debugPutio',
      title: 'Put.io Debug Info',
      contexts: ['page'],
      documentUrlPatterns: ['https://*/*', 'http://*/*']
    });
    
    contextMenuCreated = true;
    Logger.info('Background', 'Context menus created successfully');
    console.log('[Put.io Extension] Context menus created successfully');
    
  } catch (error) {
    contextMenuCreated = false;
    ErrorHandler.log('ContextMenuCreate', error);
    console.error('[Put.io Extension] Failed to create context menus:', error);
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const startTime = Date.now();
  
  console.log('[Put.io Extension] Context menu clicked:', {
    menuItemId: info.menuItemId,
    hasLinkUrl: !!info.linkUrl,
    hasSelectionText: !!info.selectionText,
    selectionLength: info.selectionText?.length || 0,
    linkUrl: info.linkUrl,
    selectionPreview: info.selectionText?.substring(0, 100) || '',
    tabUrl: tab?.url,
    hostname: tab?.url ? new URL(tab.url).hostname : 'unknown'
  });
  
  Logger.info('ContextMenu', 'Context menu clicked', {
    menuItemId: info.menuItemId,
    hasLinkUrl: !!info.linkUrl,
    hasSelectionText: !!info.selectionText,
    selectionLength: info.selectionText?.length || 0,
    tabUrl: tab?.url,
    hostname: tab?.url ? new URL(tab.url).hostname : 'unknown'
  });
  
  try {
    if (!tab?.url) {
      throw new Error('No tab URL available');
    }
    
    // Handle debug menu
    if (info.menuItemId === 'debugPutio') {
      console.log('[Put.io Extension] Debug info requested');
      await handleDebugRequest(tab);
      return;
    }
    
    if (info.menuItemId !== 'sendToPutio') {
      throw new Error(`Unknown menu item: ${info.menuItemId}`);
    }
    
    await ensureDomainsLoaded();
    
    const tabUrl = new URL(tab.url);
    if (!isWhitelistedDomain(tabUrl.hostname)) {
      const message = `Domain ${tabUrl.hostname} not whitelisted`;
      console.log('[Put.io Extension]', message);
      sendNotificationToTab(tab.id, 'Domain not whitelisted', 'warning');
      Logger.warn('ContextMenu', 'Domain not whitelisted', { domain: tabUrl.hostname });
      return;
    }
    
    let magnetLinks = [];
    
    // Handle link context (when right-clicking on a link)
    if (info.linkUrl) {
      console.log('[Put.io Extension] Processing link:', info.linkUrl);
      Logger.info('ContextMenu', 'Processing link context', { linkUrl: info.linkUrl });
      
      let magnetLink = extractMagnetFromUrl(info.linkUrl);
      
      if (!magnetLink) {
        try {
          console.log('[Put.io Extension] Fetching magnet from page...');
          magnetLink = await fetchMagnetFromPage(info.linkUrl);
        } catch (fetchError) {
          ErrorHandler.log('PageFetch', fetchError, { url: info.linkUrl });
          sendNotificationToTab(tab.id, 'Failed to fetch magnet link', 'error');
          return;
        }
      }
      
      if (magnetLink) {
        magnetLinks.push(magnetLink);
        console.log('[Put.io Extension] Found magnet link from URL:', magnetLink);
      }
    }
    
    // Handle text selection context (when right-clicking on selected text)
    else if (info.selectionText) {
      console.log('[Put.io Extension] Processing text selection:', {
        length: info.selectionText.length,
        preview: info.selectionText.substring(0, 200)
      });
      
      Logger.info('ContextMenu', 'Processing text selection', { 
        selectionLength: info.selectionText.length,
        selectionPreview: info.selectionText.substring(0, 100)
      });
      
      // First, check if the selected text contains direct magnet links
      const directMagnets = extractMagnetLinksFromText(info.selectionText);
      let urls = []; // Initialize urls array
      
      if (directMagnets.length > 0) {
        console.log('[Put.io Extension] Found direct magnet links in text:', directMagnets.length);
        magnetLinks = directMagnets;
      } else {
        // If no direct magnets, check if the text contains URLs that might have magnets
        urls = extractUrlsFromText(info.selectionText);
        console.log('[Put.io Extension] Found URLs in text:', urls.length);
        
        if (urls.length > 0) {
          console.log('[Put.io Extension] Fetching magnet links from URLs...');
          
          // Process each URL to find magnet links
          for (const url of urls) {
            try {
              console.log('[Put.io Extension] Processing URL:', url);
              
              // First check if the URL itself contains a magnet parameter
              let magnetLink = extractMagnetFromUrl(url);
              
              if (!magnetLink) {
                // If no direct magnet in URL, fetch the page
                console.log('[Put.io Extension] Fetching page content for:', url);
                magnetLink = await fetchMagnetFromPage(url);
              }
              
              if (magnetLink && validateMagnetLink(magnetLink)) {
                magnetLinks.push(magnetLink);
                console.log('[Put.io Extension] Found magnet from URL:', url);
              }
            } catch (error) {
              console.log('[Put.io Extension] Failed to process URL:', url, error.message);
              ErrorHandler.log('URLProcessing', error, { url });
            }
          }
        }
      }
      
      console.log('[Put.io Extension] Total magnet links found from text selection:', magnetLinks.length);
      Logger.info('ContextMenu', 'Found magnet links from text selection', { 
        directMagnets: directMagnets.length,
        urlsProcessed: urls?.length || 0,
        totalMagnets: magnetLinks.length
      });
    }
    
    console.log('[Put.io Extension] Total magnet links found:', magnetLinks.length);
    
    // If no magnet links found, we'll handle it in the notification section
    // Continue processing even with 0 magnets to show appropriate message
    
    // Process all found magnet links
    console.log('[Put.io Extension] Processing', magnetLinks.length, 'magnet links...');
    let successCount = 0;
    let errorCount = 0;
    let duplicateCount = 0;
    
    // Only process if we have magnet links
    if (magnetLinks.length > 0) {
      for (const magnetLink of magnetLinks) {
        console.log('[Put.io Extension] Processing magnet:', magnetLink.substring(0, 100) + '...');
        
        const magnetHash = extractMagnetHash(magnetLink);
        if (!magnetHash) {
          console.log('[Put.io Extension] Invalid magnet hash for:', magnetLink);
          errorCount++;
          continue;
        }
        
        if (await isDuplicateMagnet(magnetHash)) {
          console.log('[Put.io Extension] Duplicate magnet:', magnetHash);
          duplicateCount++;
          continue;
        }
        
        const result = await sendWithRetry(() => sendToPutioAPI(magnetLink));
        
        if (result.success) {
          console.log('[Put.io Extension] Successfully sent magnet:', magnetHash);
          await markMagnetSubmitted(magnetHash);
          successCount++;
        } else {
          console.log('[Put.io Extension] Failed to send magnet:', magnetHash, result.error);
          errorCount++;
        }
      }
    }
    
    // Send appropriate notification based on results
    let notificationMessage = '';
    let notificationType = 'success';
    
    if (magnetLinks.length === 1) {
      if (successCount === 1) {
        notificationMessage = 'Sent to Put.io successfully';
        notificationType = 'success';
      } else if (duplicateCount === 1) {
        notificationMessage = 'Already submitted';
        notificationType = 'warning';
      } else {
        notificationMessage = 'Failed to send';
        notificationType = 'error';
      }
    } else if (magnetLinks.length > 1) {
      // Multiple magnet links
      const messages = [];
      if (successCount > 0) messages.push(`${successCount} sent`);
      if (duplicateCount > 0) messages.push(`${duplicateCount} duplicates`);
      if (errorCount > 0) messages.push(`${errorCount} failed`);
      
      notificationMessage = messages.join(', ');
      notificationType = successCount > 0 ? 'success' : (duplicateCount > 0 ? 'warning' : 'error');
    } else {
      // No magnet links found
      if (info.selectionText) {
        const urls = extractUrlsFromText(info.selectionText);
        if (urls.length > 0) {
          notificationMessage = `No magnets found in ${urls.length} URL(s)`;
        } else {
          notificationMessage = 'No magnet links or URLs found';
        }
      } else {
        notificationMessage = 'No magnet links found';
      }
      notificationType = 'warning';
    }
    
    console.log('[Put.io Extension] Final result:', {
      total: magnetLinks.length,
      success: successCount,
      duplicates: duplicateCount,
      errors: errorCount,
      message: notificationMessage
    });
    
    sendNotificationToTab(tab.id, notificationMessage, notificationType);
    
    Logger.info('ContextMenu', 'Processing completed', { 
      linkContext: !!info.linkUrl,
      textContext: !!info.selectionText,
      total: magnetLinks.length,
      success: successCount,
      duplicates: duplicateCount,
      errors: errorCount,
      duration: Date.now() - startTime 
    });
    
  } catch (error) {
    console.error('[Put.io Extension] Context menu error:', error);
    ErrorHandler.log('ContextMenu', error, { 
      menuItemId: info.menuItemId,
      linkUrl: info.linkUrl,
      hasSelection: !!info.selectionText,
      selectionLength: info.selectionText?.length || 0
    });
    sendNotificationToTab(tab.id, 'Extension error occurred', 'error');
  }
});

async function handleDebugRequest(tab) {
  try {
    await ensureDomainsLoaded();
    const tabUrl = new URL(tab.url);
    const isWhitelisted = isWhitelistedDomain(tabUrl.hostname);
    
    const debugInfo = {
      hostname: tabUrl.hostname,
      isWhitelisted,
      whitelistedDomains: WHITELISTED_DOMAINS,
      contextMenuCreated,
      timestamp: new Date().toISOString()
    };
    
    console.log('[Put.io Extension] Debug Info:', debugInfo);
    Logger.info('Debug', 'Debug info requested', debugInfo);
    
    // Send debug info to content script
    chrome.tabs.sendMessage(tab.id, { 
      action: 'showDebugInfo', 
      debugInfo 
    }).catch(() => {
      console.log('[Put.io Extension] Could not send debug info to content script');
    });
    
    sendNotificationToTab(tab.id, `Debug: Whitelisted=${isWhitelisted}, Domain=${tabUrl.hostname}`, 'success');
    
  } catch (error) {
    ErrorHandler.log('Debug', error);
    sendNotificationToTab(tab.id, 'Debug error occurred', 'error');
  }
}

function extractMagnetLinksFromText(text) {
  try {
    console.log('[Put.io Extension] Extracting magnet links from text...');
    const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^\s"<>]*/gi;
    const matches = text.match(magnetRegex) || [];
    const uniqueMagnets = [...new Set(matches)];
    const validMagnets = uniqueMagnets.filter(link => validateMagnetLink(link));
    
    console.log('[Put.io Extension] Magnet extraction results:', {
      totalMatches: matches.length,
      uniqueMatches: uniqueMagnets.length,
      validMagnets: validMagnets.length,
      magnets: validMagnets
    });
    
    return validMagnets;
  } catch (error) {
    ErrorHandler.log('TextMagnetExtraction', error);
    return [];
  }
}

function extractUrlsFromText(text) {
  try {
    console.log('[Put.io Extension] Extracting URLs from text...');
    
    // Enhanced URL regex that captures various URL formats
    const urlRegex = /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(?:\.[a-zA-Z]{2,})+(?:\/[^\s]*)?/gi;
    const matches = text.match(urlRegex) || [];
    
    // Process and validate URLs
    const validUrls = [];
    const uniqueMatches = [...new Set(matches)];
    
    for (let url of uniqueMatches) {
      try {
        // Add protocol if missing
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
        }
        
        // Validate URL format
        const urlObj = new URL(url);
        
        // Only include HTTP/HTTPS URLs
        if (['http:', 'https:'].includes(urlObj.protocol)) {
          validUrls.push(url);
        }
      } catch (error) {
        // Invalid URL, skip it
        console.log('[Put.io Extension] Skipping invalid URL:', url);
      }
    }
    
    console.log('[Put.io Extension] URL extraction results:', {
      totalMatches: matches.length,
      uniqueMatches: uniqueMatches.length,
      validUrls: validUrls.length,
      urls: validUrls
    });
    
    return validUrls;
  } catch (error) {
    ErrorHandler.log('TextUrlExtraction', error);
    return [];
  }
}

async function fetchMagnetFromPage(url) {
  try {
    console.log('[Put.io Extension] Fetching magnet from page:', url);
    
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
    console.log('[Put.io Extension] Sending to Put.io API...');
    
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
      console.log('[Put.io Extension] API response:', data);
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
  console.log('[Put.io Extension] Sending notification:', { tabId, message, type });
  chrome.tabs.sendMessage(tabId, {
    action: 'showNotification',
    message,
    type
  }).catch(() => {
    console.log('[Put.io Extension] Failed to send notification to tab');
  });
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Put.io Extension] Message received:', request);
  
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
  console.log('[Put.io Extension] Extension suspending...');
  activeRequests.clear();
  requestQueue.length = 0;
});

// Cleanup expired transfers periodically
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
      console.log('[Put.io Extension] Cleaned', cleanedCount, 'expired transfers');
    }
  } catch (error) {
    ErrorHandler.log('Cleanup', error);
  }
}, 30 * 60 * 1000);