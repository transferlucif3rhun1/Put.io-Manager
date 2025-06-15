const MAGNET_REGEX = /magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^\s"]*/gi;

let isExtensionActive = false;
let processingQueue = new Set();
let injectedIcons = new Set();
let observer = null;
let domainsReady = false;

const ErrorHandler = {
  log(context, error) {
    const errorMessage = error?.message || error || 'Unknown error';
    Logger.error('ContentScript', `${context}: ${errorMessage}`);
    console.error(`[Put.io Extension] ContentScript ${context}:`, errorMessage, error);
  }
};

async function initializeExtension() {
  try {
    console.log('[Put.io Extension] Content script initializing...');
    
    await ensureDomainsLoaded();
    domainsReady = true;
    isExtensionActive = isWhitelistedDomain();
    
    console.log('[Put.io Extension] Initialization status:', {
      hostname: window.location.hostname,
      isWhitelisted: isExtensionActive,
      domainsReady: domainsReady,
      whitelistedDomains: WHITELISTED_DOMAINS
    });
    
    if (isExtensionActive) {
      addSimpleStyles();
      await injectIcons();
      startObserving();
      
      console.log('[Put.io Extension] Extension active - context menu and icons enabled');
      Logger.info('ContentScript', 'Context menu ready for domain', { 
        hostname: window.location.hostname,
        isActive: isExtensionActive
      });
    } else {
      console.log('[Put.io Extension] Domain not whitelisted - extension inactive');
      Logger.warn('ContentScript', 'Domain not whitelisted for context menu', { 
        hostname: window.location.hostname 
      });
    }
    
    Logger.info('ContentScript', 'Initialized', { 
      active: isExtensionActive,
      hostname: window.location.hostname,
      domainsReady: domainsReady
    });
    
  } catch (error) {
    ErrorHandler.log('Initialize', error);
  }
}

function addSimpleStyles() {
  if (document.getElementById('putio-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'putio-styles';
  style.textContent = `
    .putio-icon {
      display: inline-block;
      width: 18px;
      height: 18px;
      margin-left: 4px;
      vertical-align: middle;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.2s ease;
      background: transparent;
      border: none;
      opacity: 0.9;
    }
    
    .putio-icon.compact {
      width: 16px;
      height: 16px;
      margin-left: 3px;
      border-radius: 3px;
    }
    
    .putio-icon.medium {
      width: 20px;
      height: 20px;
      margin-left: 4px;
      border-radius: 4px;
    }
    
    .putio-icon.large {
      width: 24px;
      height: 24px;
      margin-left: 5px;
      border-radius: 5px;
    }
    
    .putio-icon:hover {
      transform: translateY(-1px) scale(1.05);
      opacity: 1;
      filter: drop-shadow(0 3px 12px rgba(102, 126, 234, 0.4));
    }
    
    .putio-loading {
      border-radius: 50%;
      animation: putio-spin 1s linear infinite;
      display: inline-block;
      vertical-align: middle;
      opacity: 0.9;
    }
    
    .putio-loading {
      width: 18px;
      height: 18px;
      border: 2px solid #e2e8f0;
      border-top: 2px solid #667eea;
      margin-left: 4px;
    }
    
    .putio-loading.compact {
      width: 16px;
      height: 16px;
      margin-left: 3px;
      border-width: 2px;
    }
    
    .putio-loading.medium {
      width: 20px;
      height: 20px;
      margin-left: 4px;
      border-width: 2px;
    }
    
    .putio-loading.large {
      width: 24px;
      height: 24px;
      margin-left: 5px;
      border-width: 3px;
    }
    
    .putio-success, .putio-error {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 700;
      vertical-align: middle;
      animation: putio-success-bounce 0.5s ease;
    }
    
    .putio-success {
      background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
      box-shadow: 0 2px 8px rgba(72, 187, 120, 0.35);
    }
    
    .putio-error {
      background: linear-gradient(135deg, #fc8181 0%, #e53e3e 100%);
      box-shadow: 0 2px 8px rgba(229, 62, 62, 0.35);
      animation: putio-error-shake 0.5s ease;
    }
    
    .putio-success, .putio-error {
      width: 18px;
      height: 18px;
      margin-left: 4px;
      border-radius: 4px;
      font-size: 11px;
    }
    
    .putio-success.compact, .putio-error.compact {
      width: 16px;
      height: 16px;
      margin-left: 3px;
      border-radius: 3px;
      font-size: 10px;
    }
    
    .putio-success.medium, .putio-error.medium {
      width: 20px;
      height: 20px;
      margin-left: 4px;
      border-radius: 4px;
      font-size: 12px;
    }
    
    .putio-success.large, .putio-error.large {
      width: 24px;
      height: 24px;
      margin-left: 5px;
      border-radius: 5px;
      font-size: 14px;
    }
    
    .putio-notification {
      position: fixed;
      top: 24px;
      right: 24px;
      padding: 16px 20px;
      border-radius: 12px;
      color: white;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      font-size: 14px;
      font-weight: 500;
      z-index: 10000;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
      max-width: 320px;
      word-wrap: break-word;
      cursor: pointer;
      animation: putio-slide-in 0.3s ease;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    .putio-notification.success { 
      background: linear-gradient(135deg, rgba(72, 187, 120, 0.95) 0%, rgba(56, 161, 105, 0.95) 100%);
    }
    
    .putio-notification.warning { 
      background: linear-gradient(135deg, rgba(245, 173, 85, 0.95) 0%, rgba(255, 152, 0, 0.95) 100%);
    }
    
    .putio-notification.error { 
      background: linear-gradient(135deg, rgba(252, 129, 129, 0.95) 0%, rgba(229, 62, 62, 0.95) 100%);
    }
    
    .putio-notification.slide-out {
      animation: putio-slide-out 0.3s ease forwards;
    }
    
    .putio-debug-info {
      position: fixed;
      top: 100px;
      right: 24px;
      padding: 16px;
      background: rgba(0, 0, 0, 0.9);
      color: #00ff00;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      border-radius: 8px;
      z-index: 10001;
      max-width: 400px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    
    @keyframes putio-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    @keyframes putio-success-bounce {
      0% { transform: scale(0); opacity: 0; }
      50% { transform: scale(1.2); }
      100% { transform: scale(1); opacity: 1; }
    }
    
    @keyframes putio-error-shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-2px); }
      75% { transform: translateX(2px); }
    }
    
    @keyframes putio-slide-in {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    
    @keyframes putio-slide-out {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(100%); opacity: 0; }
    }
  `;
  
  document.head.appendChild(style);
  console.log('[Put.io Extension] Styles added');
}

function determineIconSize(parentElement, magnetLink) {
  if (!parentElement) return 'compact';
  
  // Find the closest interactive or styled element
  const styledParent = parentElement.closest('button, a, .btn, [role="button"], .download, .magnet, .torrent') || parentElement;
  
  // Check if this is a plain text context
  const isPlainText = !styledParent.classList.length && 
                     styledParent.tagName.toLowerCase() === 'a' &&
                     !styledParent.style.cssText;
  
  if (isPlainText) {
    return 'compact'; // 16px for plain text
  }
  
  // Get actual dimensions of the container
  const styles = window.getComputedStyle(styledParent);
  const height = parseInt(styles.height) || styledParent.offsetHeight || 0;
  const fontSize = parseInt(styles.fontSize) || 14;
  
  // Check for explicit size classes first
  const classNames = styledParent.className.toLowerCase();
  const hasLargeClass = /large|big|xl|lg/.test(classNames);
  const hasSmallClass = /small|sm|mini|compact/.test(classNames);
  
  if (hasSmallClass) return 'compact'; // 16px
  if (hasLargeClass && height > 50) return 'large'; // 24px only if actually large
  
  // Size proportionally to container height (icon should be 50-70% of container height)
  if (height > 0) {
    const targetIconSize = Math.floor(height * 0.5); // 50% of container height (more conservative)
    
    if (targetIconSize <= 16) return 'compact';      // 16px
    if (targetIconSize <= 18) return '';             // 18px (default)  
    if (targetIconSize <= 20) return 'medium';       // 20px
    if (targetIconSize <= 24) return 'large';        // 24px (max size)
    return 'large'; // Cap at large size (24px) for all larger containers
  }
  
  // Fallback based on font size (more conservative)
  if (fontSize <= 12) return 'compact';  // 16px
  if (fontSize <= 16) return '';         // 18px (default)
  if (fontSize <= 18) return 'medium';   // 20px
  return 'large'; // Cap at large (24px) for largest fonts
}

function createIcon(magnetHash, parentElement = null, magnetLink = '') {
  try {
    const icon = document.createElement('img');
    icon.className = 'putio-icon';
    icon.src = chrome.runtime.getURL('icon.png');
    icon.title = 'Send to Put.io';
    icon.alt = 'Put.io';
    icon.dataset.magnetHash = magnetHash;
    
    // Determine size based on context
    const sizeClass = determineIconSize(parentElement, magnetLink);
    if (sizeClass && sizeClass !== 'default') {
      icon.classList.add(sizeClass);
    }
    
    icon.onerror = function() {
      if (!this.parentNode) return; // Safety check
      
      const fallback = document.createElement('div');
      fallback.innerHTML = '⬇';
      fallback.className = `putio-icon ${sizeClass || ''}`;
      fallback.title = 'Send to Put.io';
      fallback.dataset.magnetHash = magnetHash;
      
      // Size mapping for fallback
      const sizeMap = {
        compact: { size: 16, font: 10, margin: 3, radius: 3 },
        medium: { size: 20, font: 12, margin: 4, radius: 4 },
        large: { size: 24, font: 14, margin: 5, radius: 5 }
      };
      
      const config = sizeMap[sizeClass] || { size: 18, font: 11, margin: 4, radius: 4 };
      
      fallback.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: ${config.size}px;
        height: ${config.size}px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border-radius: ${config.radius}px;
        text-align: center;
        font-size: ${config.font}px;
        margin-left: ${config.margin}px;
        vertical-align: middle;
        cursor: pointer;
        font-weight: 600;
        border: none;
        opacity: 0.9;
        transition: all 0.2s ease;
        box-shadow: 0 2px 8px rgba(102, 126, 234, 0.25);
      `;
      
      fallback.addEventListener('mouseenter', function() {
        this.style.transform = 'translateY(-1px) scale(1.05)';
        this.style.opacity = '1';
        this.style.boxShadow = '0 3px 12px rgba(102, 126, 234, 0.4)';
      });
      
      fallback.addEventListener('mouseleave', function() {
        this.style.transform = '';
        this.style.opacity = '0.9';
        this.style.boxShadow = '0 2px 8px rgba(102, 126, 234, 0.25)';
      });
      
      try {
        this.parentNode.replaceChild(fallback, this);
      } catch (error) {
        ErrorHandler.log('FallbackReplace', error);
      }
    };
    
    return icon;
  } catch (error) {
    ErrorHandler.log('CreateIcon', error);
    return null;
  }
}

function showIconState(icon, state) {
  if (!icon || !icon.parentNode) return null;
  
  const magnetHash = icon.dataset.magnetHash;
  const sizeClass = getSizeClass(icon);
  
  let newElement;
  
  switch (state) {
    case 'loading':
      newElement = document.createElement('div');
      newElement.className = `putio-loading ${sizeClass}`;
      newElement.dataset.magnetHash = magnetHash;
      icon.parentNode.replaceChild(newElement, icon);
      break;
      
    case 'success':
      newElement = document.createElement('div');
      newElement.className = `putio-success ${sizeClass}`;
      newElement.innerHTML = '✓';
      newElement.dataset.magnetHash = magnetHash;
      icon.parentNode.replaceChild(newElement, icon);
      break;
      
    case 'error':
      newElement = document.createElement('div');
      newElement.className = `putio-error ${sizeClass}`;
      newElement.innerHTML = '✕';
      newElement.dataset.magnetHash = magnetHash;
      icon.parentNode.replaceChild(newElement, icon);
      break;
  }
  
  return newElement; // Return the new element for reference tracking
}

function getSizeClass(element) {
  if (!element) return '';
  
  const classes = ['compact', 'medium', 'large'];
  
  // Check classList first
  for (const cls of classes) {
    if (element.classList.contains(cls)) {
      return cls;
    }
  }
  
  // Fallback to className string check
  const className = element.className || '';
  for (const cls of classes) {
    if (className.includes(cls)) {
      return cls;
    }
  }
  
  // If no size class found, try to determine from element dimensions as fallback
  if (element.parentNode) {
    const width = element.offsetWidth || parseInt(getComputedStyle(element).width) || 0;
    if (width >= 24) return 'large';
    if (width >= 20) return 'medium';  
    if (width >= 16) return 'compact';
  }
  
  return '';
}

async function isMagnetSubmitted(magnetHash) {
  try {
    const result = await chrome.storage.local.get(['transfers', 'retentionDays']);
    const transfers = result.transfers || {};
    const retentionDays = result.retentionDays || 7;
    const expirationTime = retentionDays * 24 * 60 * 60 * 1000;
    
    if (transfers[magnetHash]) {
      const age = Date.now() - transfers[magnetHash].timestamp;
      return age < expirationTime;
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
      source: 'content_script',
      url: window.location.href
    };
    await chrome.storage.local.set({ transfers });
  } catch (error) {
    ErrorHandler.log('MarkSubmitted', error);
  }
}

async function sendMagnetToPutio(magnetLink, iconElement) {
  const magnetHash = extractMagnetHash(magnetLink);
  
  console.log('[Put.io Extension] Sending magnet via icon click:', {
    magnetHash,
    magnetLink: magnetLink.substring(0, 100) + '...'
  });
  
  if (processingQueue.has(magnetHash)) {
    showNotification('Already processing this magnet', 'warning');
    return;
  }

  let currentElement = iconElement;

  try {
    if (!validateMagnetLink(magnetLink) || !magnetHash) {
      throw new Error('Invalid magnet link');
    }
    
    if (await isMagnetSubmitted(magnetHash)) {
      showNotification('Magnet already submitted', 'warning');
      removeIcon(currentElement);
      return;
    }

    processingQueue.add(magnetHash);
    currentElement = showIconState(currentElement, 'loading') || currentElement;

    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Request timeout')), 30000);
      
      try {
        chrome.runtime.sendMessage({
          action: 'sendToPutio',
          magnetLink: magnetLink
        }, (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            const error = chrome.runtime.lastError.message;
            if (error.includes('Extension context invalidated')) {
              reject(new Error('Extension was reloaded. Please refresh the page.'));
            } else {
              reject(new Error(error));
            }
          } else {
            resolve(response);
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });

    if (response && response.success) {
      await markMagnetSubmitted(magnetHash);
      currentElement = showIconState(currentElement, 'success') || currentElement;
      showNotification('Sent to Put.io successfully', 'success');
      setTimeout(() => removeIcon(currentElement), 2000);
    } else {
      currentElement = showIconState(currentElement, 'error') || currentElement;
      showNotification(response?.error || 'Failed to send to Put.io', 'error');
      setTimeout(() => recreateIcon(currentElement, magnetHash, magnetLink), 3000);
    }

  } catch (error) {
    ErrorHandler.log('SendMagnet', error);
    currentElement = showIconState(currentElement, 'error') || currentElement;
    
    let errorMessage = 'Error occurred';
    if (error.message.includes('Extension was reloaded')) {
      errorMessage = 'Extension reloaded - refresh page';
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Request timeout';
    }
    
    showNotification(errorMessage, 'error');
    setTimeout(() => recreateIcon(currentElement, magnetHash, magnetLink), 3000);
  } finally {
    processingQueue.delete(magnetHash);
  }
}

function recreateIcon(iconElement, magnetHash, magnetLink) {
  if (!iconElement || !iconElement.parentNode) return;
  
  try {
    const sizeClass = getSizeClass(iconElement);
    const newIcon = createIcon(magnetHash, iconElement.parentNode, magnetLink);
    
    if (sizeClass) {
      newIcon.classList.add(sizeClass);
    }
    
    setupIconClick(newIcon, magnetLink);
    iconElement.parentNode.replaceChild(newIcon, iconElement);
  } catch (error) {
    ErrorHandler.log('RecreateIcon', error);
  }
}

function setupIconClick(icon, magnetLink) {
  icon.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[Put.io Extension] Icon clicked for magnet:', extractMagnetHash(magnetLink));
    sendMagnetToPutio(magnetLink, icon);
  }, { passive: false });
}

function removeIcon(icon) {
  if (!icon) return;
  
  try {
    const magnetHash = icon.dataset.magnetHash;
    
    // Remove from DOM if still attached
    if (icon.parentNode) {
      icon.parentNode.removeChild(icon);
    }
    
    // Clean up from tracking
    if (magnetHash) {
      injectedIcons.delete(magnetHash);
    }
  } catch (error) {
    ErrorHandler.log('RemoveIcon', error);
  }
}

async function injectIcons() {
  if (!isExtensionActive || !domainsReady) return;
  
  try {
    console.log('[Put.io Extension] Injecting icons...');
    
    const magnetLinks = document.querySelectorAll('a[href*="magnet:"]');
    console.log('[Put.io Extension] Found', magnetLinks.length, 'magnet links');
    
    for (const link of magnetLinks) {
      await processLink(link);
    }
    
    await processTextMagnets();
    
    console.log('[Put.io Extension] Icon injection completed');
    
  } catch (error) {
    ErrorHandler.log('InjectIcons', error);
  }
}

async function processLink(link) {
  try {
    if (!link || !link.href) return;
    
    const magnetLink = extractMagnetFromUrl(link.href);
    if (!magnetLink || !validateMagnetLink(magnetLink)) return;

    const magnetHash = extractMagnetHash(magnetLink);
    if (!magnetHash || injectedIcons.has(magnetHash)) return;
    
    if (link.querySelector('.putio-icon, .putio-loading, .putio-success, .putio-error')) return;
    
    if (await isMagnetSubmitted(magnetHash)) return;

    const icon = createIcon(magnetHash, link, magnetLink);
    if (!icon) return;
    
    setupIconClick(icon, magnetLink);
    
    if (link.parentNode) {
      link.parentNode.insertBefore(icon, link.nextSibling);
      injectedIcons.add(magnetHash);
      console.log('[Put.io Extension] Icon injected for magnet:', magnetHash);
    }
    
  } catch (error) {
    ErrorHandler.log('ProcessLink', error);
  }
}

async function processTextMagnets() {
  try {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          return node.textContent.includes('magnet:') ? 
            NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );
    
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }
    
    console.log('[Put.io Extension] Found', textNodes.length, 'text nodes with magnet links');
    
    for (const textNode of textNodes) {
      if (!textNode.parentNode) continue;
      
      const text = textNode.textContent;
      const magnetMatches = text.match(MAGNET_REGEX);
      
      if (magnetMatches) {
        for (const magnetLink of magnetMatches) {
          if (!validateMagnetLink(magnetLink)) continue;
          
          const magnetHash = extractMagnetHash(magnetLink);
          if (!magnetHash || injectedIcons.has(magnetHash)) continue;
          
          if (await isMagnetSubmitted(magnetHash)) continue;
          
          const icon = createIcon(magnetHash, textNode.parentNode, magnetLink);
          if (!icon) continue;
          
          setupIconClick(icon, magnetLink);
          
          if (textNode.parentNode) {
            textNode.parentNode.insertBefore(icon, textNode.nextSibling);
            injectedIcons.add(magnetHash);
            console.log('[Put.io Extension] Icon injected for text magnet:', magnetHash);
          }
        }
      }
    }
  } catch (error) {
    ErrorHandler.log('ProcessTextMagnets', error);
  }
}

let injectTimeout;
function debouncedInject() {
  clearTimeout(injectTimeout);
  injectTimeout = setTimeout(injectIcons, 500);
}

function startObserving() {
  if (observer || !isExtensionActive) return;
  
  console.log('[Put.io Extension] Starting DOM observer...');
  
  observer = new MutationObserver((mutations) => {
    let shouldInject = false;
    
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.querySelector?.('a[href*="magnet:"]') || 
                (node.textContent && node.textContent.includes('magnet:'))) {
              shouldInject = true;
              break;
            }
          }
        }
      }
      if (shouldInject) break;
    }
    
    if (shouldInject) {
      console.log('[Put.io Extension] DOM changes detected, re-injecting icons...');
      debouncedInject();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function showNotification(message, type, duration = 3000) {
  try {
    console.log('[Put.io Extension] Showing notification:', { message, type });
    
    const existing = document.querySelector('.putio-notification');
    if (existing) {
      existing.classList.add('slide-out');
      setTimeout(() => existing.remove(), 300);
    }

    const notification = document.createElement('div');
    notification.className = `putio-notification ${type}`;
    notification.textContent = message;
    
    notification.addEventListener('click', () => {
      notification.classList.add('slide-out');
      setTimeout(() => notification.remove(), 300);
    });
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentNode) {
        notification.classList.add('slide-out');
        setTimeout(() => notification.remove(), 300);
      }
    }, duration);
    
  } catch (error) {
    ErrorHandler.log('ShowNotification', error);
  }
}

function showDebugInfo(debugInfo) {
  try {
    console.log('[Put.io Extension] Showing debug info:', debugInfo);
    
    // Remove existing debug info
    const existing = document.querySelector('.putio-debug-info');
    if (existing) {
      existing.remove();
    }
    
    const debugDiv = document.createElement('div');
    debugDiv.className = 'putio-debug-info';
    debugDiv.textContent = JSON.stringify(debugInfo, null, 2);
    
    debugDiv.addEventListener('click', () => {
      debugDiv.remove();
    });
    
    document.body.appendChild(debugDiv);
    
    // Auto-remove after 10 seconds
    setTimeout(() => {
      if (debugDiv.parentNode) {
        debugDiv.remove();
      }
    }, 10000);
    
  } catch (error) {
    ErrorHandler.log('ShowDebugInfo', error);
  }
}

// Handle messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    console.log('[Put.io Extension] Content script received message:', request);
    
    switch (request.action) {
      case 'showNotification':
        showNotification(request.message, request.type);
        break;
        
      case 'showDebugInfo':
        showDebugInfo(request.debugInfo);
        break;
        
      case 'reloadWhitelist':
        ensureDomainsLoaded().then(() => {
          const wasActive = isExtensionActive;
          isExtensionActive = isWhitelistedDomain();
          
          console.log('[Put.io Extension] Whitelist reloaded:', {
            wasActive,
            nowActive: isExtensionActive,
            hostname: window.location.hostname
          });
          
          Logger.info('ContentScript', 'Whitelist reloaded', {
            wasActive,
            nowActive: isExtensionActive,
            hostname: window.location.hostname
          });
          
          if (wasActive && !isExtensionActive) {
            // Deactivate extension
            document.querySelectorAll('.putio-icon, .putio-loading, .putio-success, .putio-error')
              .forEach(el => el.remove());
            injectedIcons.clear();
            
            if (observer) {
              observer.disconnect();
              observer = null;
            }
          } else if (!wasActive && isExtensionActive) {
            // Activate extension
            addSimpleStyles();
            injectIcons();
            startObserving();
          }
        });
        break;
    }
  } catch (error) {
    ErrorHandler.log('MessageHandler', error);
  }
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
  initializeExtension();
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  console.log('[Put.io Extension] Page unloading, cleaning up...');
  if (observer) {
    observer.disconnect();
  }
  processingQueue.clear();
  injectedIcons.clear();
});