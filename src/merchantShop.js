class MerchantShop {
	constructor() {
		this.open = false;
		this.closing = false; // Track if we're in closing animation
		this.inventory = []; // Array of shop items from server
		this.selectedItems = []; // Array of selected item indices
		this.animTime = 0;
		this.animDuration = 0.25;
		
		// UI rectangles for interaction
		this.closeRect = null;
		this.buyButtonRect = null;
		this.cancelButtonRect = null;
		this.itemRects = [];
		this.hoveredItemIndex = -1;
		this.hoveredButton = null; // 'close' | 'buy' | 'cancel'
		
		// Mouse state
		this._prevMouseDown = false;
	}

	openShop() {
		console.log('[Shop] Opening shop, setting _prevMouseDown=true to require fresh click');
		this.open = true;
		this.closing = false;
		this.animTime = 0;
		this.selectedItems = [];
		this.hoveredItemIndex = -1;
		this.hoveredButton = null;
		this._prevMouseDown = true; // Prevent spurious clicks on first frame - require fresh click after shop opens
		
		// Request shop inventory from server
		if (window.networkManager && window.networkManager.connected) {
			window.networkManager.socket.emit('requestShopInventory');
		}
	}

	close() {
		// Start closing animation instead of instantly closing
		if (!this.closing) {
			this.closing = true;
			this.animTime = this.animDuration; // Start from full open
		}
	}
	
	_finishClose() {
		// Actually close the shop after animation completes
		this.open = false;
		this.closing = false;
		this.selectedItems = [];
		this.hoveredItemIndex = -1;
		this.hoveredButton = null;
		
		// Reopen merchant dialogue at start
		if (window.dialogueBox && window.Merchant) {
			const merchant = this._findMerchantNPC();
			if (merchant) {
				this._openMerchantDialogue(merchant);
			}
		}
	}

	_findMerchantNPC() {
		if (!window.npcs || !Array.isArray(window.npcs.items)) return null;
		for (let i = 0; i < window.npcs.items.length; i++) {
			const npc = window.npcs.items[i];
			if (npc && npc.name === 'Merchant' && npc.alive) {
				return npc;
			}
		}
		return null;
	}

	_openMerchantDialogue(merchant) {
		// Load and open merchant dialogue
		if (window.dialogueLoader && window.dialogueBox) {
			window.dialogueLoader.load(merchant.name).then(data => {
				if (data && data.nodes) {
					window.dialogueBox.openWith({
						title: data.title || 'Merchant',
						nodes: data.nodes,
						start: data.start || 'start',
						typeSpeed: 60
					});
				}
			}).catch(() => {});
		}
	}

	setInventory(items) {
		this.inventory = items || [];
	}

	update(dt, mouseX, mouseY, mouseDown) {
		if (!this.open) return;
		
		// Animation (opening or closing)
		if (this.closing) {
			// Closing animation - count down
			this.animTime -= dt;
			if (this.animTime <= 0) {
				this.animTime = 0;
				this._finishClose();
				return;
			}
			// Don't process input while closing
			this._prevMouseDown = mouseDown;
			return;
		} else {
			// Opening animation - count up
			if (this.animTime < this.animDuration) {
				this.animTime += dt;
			}
		}

		// Update hover states
		this.hoveredItemIndex = -1;
		this.hoveredButton = null;

		// Check item hover
		for (let i = 0; i < this.itemRects.length; i++) {
			const rect = this.itemRects[i];
			if (rect && mouseX >= rect.x && mouseX <= rect.x + rect.w && 
			    mouseY >= rect.y && mouseY <= rect.y + rect.h) {
				this.hoveredItemIndex = i;
				break;
			}
		}

		// Check button hover
		if (this.closeRect && mouseX >= this.closeRect.x && mouseX <= this.closeRect.x + this.closeRect.w &&
		    mouseY >= this.closeRect.y && mouseY <= this.closeRect.y + this.closeRect.h) {
			this.hoveredButton = 'close';
		}
		if (this.buyButtonRect && mouseX >= this.buyButtonRect.x && mouseX <= this.buyButtonRect.x + this.buyButtonRect.w &&
		    mouseY >= this.buyButtonRect.y && mouseY <= this.buyButtonRect.y + this.buyButtonRect.h) {
			this.hoveredButton = 'buy';
		}
		if (this.cancelButtonRect && mouseX >= this.cancelButtonRect.x && mouseX <= this.cancelButtonRect.x + this.cancelButtonRect.w &&
		    mouseY >= this.cancelButtonRect.y && mouseY <= this.cancelButtonRect.y + this.cancelButtonRect.h) {
			this.hoveredButton = 'cancel';
		}

		// Handle clicks
		const clicked = mouseDown && !this._prevMouseDown;
		console.log('[Shop] Click detection:', { clicked, mouseDown, prev: this._prevMouseDown, hoveredButton: this.hoveredButton, selectedCount: this.selectedItems?.length });
		if (clicked) {
			if (this.hoveredButton === 'close') {
				this.close();
			} else if (this.hoveredButton === 'cancel') {
				// Deselect all items
				if (!this.selectedItems) this.selectedItems = [];
				this.selectedItems = [];
			} else if (this.hoveredButton === 'buy' && this.selectedItems && this.selectedItems.length > 0) {
				console.log('[Shop] Buy button clicked!');
				this._purchaseSelectedItems();
			} else if (this.hoveredItemIndex >= 0) {
				// Toggle selection
				const item = this.inventory[this.hoveredItemIndex];
				if (item && !item.sold && !item.placeholder) {
					if (!this.selectedItems) this.selectedItems = [];
					const idx = this.selectedItems.indexOf(this.hoveredItemIndex);
					if (idx >= 0) {
						// Deselect
						this.selectedItems.splice(idx, 1);
					} else {
						// Select
						this.selectedItems.push(this.hoveredItemIndex);
					}
				}
			}
		}

		this._prevMouseDown = mouseDown;
	}

	_purchaseSelectedItems() {
		console.log('[Shop] _purchaseSelectedItems called', { 
			selectedItems: this.selectedItems, 
			playerExists: !!window.player,
			inventorySize: window.player?.inventory?.length,
			networkConnected: window.networkManager?.connected 
		});
		if (!this.selectedItems || this.selectedItems.length === 0) {
			console.log('[Shop] Early return: no selected items');
			return;
		}
		
	// Check inventory space
	const player = window.player;
	if (!player) {
		console.log('[Shop] Early return: no player');
		return;
	}
	
	const currentInventorySize = (player.inventory || []).length;
	const maxInventorySize = 6; // Standard inventory size
	
	// Only count items that need inventory space (exclude cosmetics like hats and skins)
	let spaceNeeded = 0;
	for (const index of this.selectedItems) {
		if (index >= 0 && index < this.inventory.length) {
			const item = this.inventory[index];
			// Cosmetic items (hats, skins) don't need inventory space
			if (item && item.type !== 'hat' && item.type !== 'skin') {
				spaceNeeded++;
			}
		}
	}
	
	const spaceAvailable = maxInventorySize - currentInventorySize;
	
	console.log('[Shop] Inventory check:', { currentInventorySize, maxInventorySize, spaceNeeded, spaceAvailable });
		
		if (spaceNeeded > spaceAvailable) {
			// Show notification
			if (window.ui && typeof window.ui.showNotification === 'function') {
				window.ui.showNotification('Make more space in your inventory', 3000);
			}
			console.log('[Shop] Not enough inventory space');
			return;
		}

		// Send purchase request to server (one at a time for now, server will handle batching)
		if (window.networkManager && window.networkManager.connected) {
			console.log('[Shop] Sending purchase request to server for items:', this.selectedItems);
			for (const index of this.selectedItems) {
				window.networkManager.socket.emit('purchaseShopItem', { index });
			}
			// Selection will be cleared when server responds
			this.selectedItems = [];
		} else {
			console.log('[Shop] Not connected to network manager');
		}
	}

	draw(ctx, viewportWidth, viewportHeight, player) {
		if (!this.open) return;

		// Calculate animation progress (0 to 1)
		// When opening: animTime goes 0 -> duration, t goes 0 -> 1
		// When closing: animTime goes duration -> 0, t goes 1 -> 0
		const t = Math.min(1, Math.max(0, this.animTime / this.animDuration));
		const scale = 0.85 + 0.15 * this._easeOutCubic(t);
		const alpha = t;

		ctx.save();
		ctx.globalAlpha = alpha;

		// Dim background
		ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
		ctx.fillRect(0, 0, viewportWidth, viewportHeight);

		// Shop window dimensions
		const boxWidth = 700;
		const boxHeight = 680; // Compact height for centered grid
		const boxX = (viewportWidth - boxWidth) / 2;
		const boxY = (viewportHeight - boxHeight) / 2;

		ctx.save();
		ctx.translate(boxX + boxWidth / 2, boxY + boxHeight / 2);
		ctx.scale(scale, scale);
		ctx.translate(-(boxX + boxWidth / 2), -(boxY + boxHeight / 2));

		// Window background
		ctx.fillStyle = 'rgba(30, 25, 20, 0.95)';
		ctx.strokeStyle = '#8b7355';
		ctx.lineWidth = 3;
		ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
		ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);

		// Title with underline
		ctx.fillStyle = '#f4e4c1';
		ctx.font = 'bold 28px serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		const titleY = boxY + 24;
		ctx.fillText('Merchant of New Antioch', boxX + boxWidth / 2, titleY);
		
		// Title underline
		const titleWidth = ctx.measureText('Merchant of New Antioch').width;
		ctx.strokeStyle = '#f4e4c1';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(boxX + (boxWidth - titleWidth) / 2, titleY + 34);
		ctx.lineTo(boxX + (boxWidth + titleWidth) / 2, titleY + 34);
		ctx.stroke();

		// Close button (X)
		const closeSize = 32;
		const closeX = boxX + boxWidth - closeSize - 16;
		const closeY = boxY + 16;
		this.closeRect = { x: closeX, y: closeY, w: closeSize, h: closeSize };
		
		ctx.fillStyle = this.hoveredButton === 'close' ? 'rgba(200, 60, 60, 0.9)' : 'rgba(140, 40, 40, 0.8)';
		ctx.fillRect(closeX, closeY, closeSize, closeSize);
		ctx.strokeStyle = '#000';
		ctx.lineWidth = 2;
		ctx.strokeRect(closeX, closeY, closeSize, closeSize);
		
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(closeX + 8, closeY + 8);
		ctx.lineTo(closeX + closeSize - 8, closeY + closeSize - 8);
		ctx.moveTo(closeX + closeSize - 8, closeY + 8);
		ctx.lineTo(closeX + 8, closeY + closeSize - 8);
		ctx.stroke();

		// Currency display at top (more space from title)
		const currencyY = boxY + 85;
		this._drawCurrencyDisplay(ctx, boxX, currencyY, boxWidth, player);

		// Items section (centered grid, starts below currency)
		const itemsY = boxY + 115;
		this._drawItemsGrid(ctx, boxX, itemsY, boxWidth);

		// Total and buttons at bottom (button bar is 60px tall)
		const bottomY = boxY + boxHeight - 65;
		this._drawBottomControls(ctx, boxX, bottomY, boxWidth, player);

		ctx.restore();
		ctx.restore();
	}

	_drawCurrencyDisplay(ctx, boxX, currencyY, boxWidth, player) {
		const vp = player?.victoryPoints || 0;
		const bm = player?.bloodMarkers || 0;
		const ducats = player?.ducats || 0;

		// Compact spacing between currency types
		const itemSpacing = 80; // Tight spacing between each currency
		
		ctx.font = 'bold 20px monospace';
		ctx.textBaseline = 'middle';
		
		// Calculate total width of currency display
		const totalCurrencyWidth = itemSpacing * 2; // 2 gaps between 3 items
		
		// Center the entire currency display
		const centerX = boxX + boxWidth / 2;
		const startX = centerX - totalCurrencyWidth / 2;
		
		// Victory Points (4-sided star icon)
		const vpX = startX;
		this._drawVPIcon(ctx, vpX, currencyY - 8, 8);
		ctx.fillStyle = '#ffec8b';
		ctx.textAlign = 'left';
		ctx.fillText(vp.toString(), vpX + 20, currencyY);

		// Blood Markers (blood drop icon)
		const bmX = startX + itemSpacing;
		this._drawBloodMarkerIcon(ctx, bmX, currencyY - 8, 8);
		ctx.fillStyle = '#ff5a5a';
		ctx.textAlign = 'left';
		ctx.fillText(bm.toString(), bmX + 20, currencyY);

		// Ducats (coin icon)
		const ducatX = startX + itemSpacing * 2;
		this._drawDucatIcon(ctx, ducatX + 6, currencyY);
		ctx.fillStyle = '#ffd36b';
		ctx.textAlign = 'left';
		ctx.fillText(ducats.toString(), ducatX + 20, currencyY);
	}

	_drawVPIcon(ctx, x, y, size) {
		// Exact copy from ui.js - 4-sided star with curved edges
		ctx.save();
		const starCX = x + size / 2;
		const starCY = y + size / 2;
		ctx.translate(starCX, starCY);
		
		// 4-pointed star with curved edges (diamond orientation, bezier curves)
		ctx.fillStyle = '#ffd700'; // Gold color
		ctx.beginPath();
		// Top point
		ctx.moveTo(0, -size);
		// Top to right (curved)
		ctx.bezierCurveTo(size * 0.3, -size * 0.4, size * 0.4, -size * 0.3, size, 0);
		// Right to bottom (curved)
		ctx.bezierCurveTo(size * 0.4, size * 0.3, size * 0.3, size * 0.4, 0, size);
		// Bottom to left (curved)
		ctx.bezierCurveTo(-size * 0.3, size * 0.4, -size * 0.4, size * 0.3, -size, 0);
		// Left to top (curved)
		ctx.bezierCurveTo(-size * 0.4, -size * 0.3, -size * 0.3, -size * 0.4, 0, -size);
		ctx.fill();
		
		// Outline
		ctx.strokeStyle = '#b8860b'; // Dark goldenrod
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(0, -size);
		ctx.bezierCurveTo(size * 0.3, -size * 0.4, size * 0.4, -size * 0.3, size, 0);
		ctx.bezierCurveTo(size * 0.4, size * 0.3, size * 0.3, size * 0.4, 0, size);
		ctx.bezierCurveTo(-size * 0.3, size * 0.4, -size * 0.4, size * 0.3, -size, 0);
		ctx.bezierCurveTo(-size * 0.4, -size * 0.3, -size * 0.3, -size * 0.4, 0, -size);
		ctx.stroke();
		
		// Inner highlight
		ctx.fillStyle = '#ffec8b';
		ctx.beginPath();
		ctx.moveTo(0, -size * 0.5);
		ctx.bezierCurveTo(size * 0.15, -size * 0.2, size * 0.2, -size * 0.15, size * 0.5, 0);
		ctx.bezierCurveTo(size * 0.2, size * 0.15, size * 0.15, size * 0.2, 0, size * 0.5);
		ctx.bezierCurveTo(-size * 0.15, size * 0.2, -size * 0.2, size * 0.15, -size * 0.5, 0);
		ctx.bezierCurveTo(-size * 0.2, -size * 0.15, -size * 0.15, -size * 0.2, 0, -size * 0.5);
		ctx.fill();
		
		ctx.restore();
	}

	_drawBloodMarkerIcon(ctx, x, y, size) {
		// Exact copy from ui.js - proper teardrop blood drop
		const dropH = size * 2; // Double size to match ui.js proportions
		const dropW = size * 1.375; // Adjusted width ratio
		
		ctx.save();
		const dropCX = x + size / 2;
		const dropCY = y + size / 2;
		ctx.translate(dropCX, dropCY);
		
		// Improved teardrop shape - thin top, fat rounded bottom
		ctx.fillStyle = '#8b0000';
		ctx.beginPath();
		// Start at very top (thin point)
		ctx.moveTo(0, -dropH/2);
		// Right side curves - gentle curve at top, wider at bottom
		ctx.bezierCurveTo(dropW/3, -dropH/3, dropW/2, -dropH/8, dropW/2, dropH/6);
		// Bottom right curve (fat rounded part)
		ctx.bezierCurveTo(dropW/2, dropH/3, dropW/3, dropH/2.2, 0, dropH/2);
		// Bottom left curve (fat rounded part)
		ctx.bezierCurveTo(-dropW/3, dropH/2.2, -dropW/2, dropH/3, -dropW/2, dropH/6);
		// Left side curves back to top
		ctx.bezierCurveTo(-dropW/2, -dropH/8, -dropW/3, -dropH/3, 0, -dropH/2);
		ctx.fill();
		
		// Outline
		ctx.strokeStyle = '#3b0000';
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(0, -dropH/2);
		ctx.bezierCurveTo(dropW/3, -dropH/3, dropW/2, -dropH/8, dropW/2, dropH/6);
		ctx.bezierCurveTo(dropW/2, dropH/3, dropW/3, dropH/2.2, 0, dropH/2);
		ctx.bezierCurveTo(-dropW/3, dropH/2.2, -dropW/2, dropH/3, -dropW/2, dropH/6);
		ctx.bezierCurveTo(-dropW/2, -dropH/8, -dropW/3, -dropH/3, 0, -dropH/2);
		ctx.stroke();
		
		// Highlight (inner lighter spot)
		ctx.fillStyle = '#c41e1e';
		ctx.beginPath();
		ctx.arc(-1, -dropH/5, 2, 0, Math.PI * 2);
		ctx.fill();
		
		ctx.restore();
	}

	_drawDucatIcon(ctx, x, y) {
		// EXACT copy from ui.js lines 239-254 - DO NOT MODIFY
		ctx.save();
		const coinR = 6;
		const coinCX = x;
		const coinCY = y;
		ctx.fillStyle = '#d4af37';
		ctx.beginPath();
		ctx.arc(coinCX, coinCY, coinR, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = '#8a6d1f';
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.fillStyle = '#f4cf47';
		ctx.beginPath();
		ctx.arc(coinCX, coinCY, coinR - 2, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}

	_drawItemsGrid(ctx, boxX, itemsY, boxWidth) {
		this.itemRects = [];

		const itemsPerRow = 4;
		const slotSize = 70; // Size matching inventory slots
		const gap = 20; // Gap between slots
		const radius = 8; // Corner radius (exact from ui.js)
		const priceSpace = 28; // Space for price below slot
		const rowSpacing = slotSize + priceSpace + 15; // Total vertical space per row
		
		// Calculate total grid dimensions
		const gridWidth = itemsPerRow * slotSize + (itemsPerRow - 1) * gap;
		const rowCount = Math.max(1, Math.ceil((this.inventory?.length || 0) / itemsPerRow));
		
		// Row labels column (left-hand side)
		const labelGap = 18;
		
		// Keep the item grid centered exactly like before
		const startX = boxX + (boxWidth - gridWidth) / 2;
		const startY = itemsY + 40; // Top padding from currency
		
		// Use whatever space exists to the left of the centered grid for labels
		const maxLabelColW = Math.max(60, (startX - boxX) - (labelGap + 10));
		// Keep labels closer to the grid (prevents them drifting too far left on wide panels)
		const labelColW = Math.min(95, maxLabelColW);
		const labelX = startX - labelGap - labelColW;

		// Decide row labels based on the row contents (keeps working if the server changes order later)
		const getRowLabel = (rowIndex, rowItems) => {
			const first = rowItems && rowItems.length ? rowItems[0] : null;
			const type = first?.type;
			const rarity = first?.rarityName;
			if (type === 'hat') return 'Hats';
			if (type === 'skin') return 'Skins';
			if (rarity === 'Epic') return 'Epic';
			if (rarity === 'Legendary') return 'Legendary';
			// Fallback to the known layout (4 rows)
			if (rowIndex === 0) return 'Epic';
			if (rowIndex === 1) return 'Legendary';
			if (rowIndex === 2) return 'Hats';
			if (rowIndex === 3) return 'Skins';
			return '';
		};

		// Draw labels (one per row, aligned to the left side of the row)
		for (let row = 0; row < rowCount; row++) {
			const rowStart = row * itemsPerRow;
			const rowEnd = Math.min(rowStart + itemsPerRow, this.inventory.length);
			const rowItems = this.inventory.slice(rowStart, rowEnd);
			const label = getRowLabel(row, rowItems);
			if (!label) continue;

			const rowTopY = startY + row * rowSpacing;
			const rowMidY = rowTopY + slotSize / 2;

			ctx.save();
			ctx.font = 'bold 16px serif';
			ctx.textAlign = 'left';
			ctx.textBaseline = 'middle';
			const textX = labelX + 6;

			// Soft shadow for readability against dark panel
			ctx.fillStyle = 'rgba(0,0,0,0.65)';
			ctx.fillText(label, textX + 1, rowMidY + 1);
			ctx.fillStyle = '#f4e4c1';
			ctx.fillText(label, textX, rowMidY);

			ctx.restore();
		}

		// Helper to draw inventory-style rounded square slot (EXACT from ui.js lines 578-609)
		const drawSlot = (x0, y0, isHovered, isSelected) => {
			ctx.save();
			ctx.beginPath();
			const r = Math.min(radius, slotSize / 2);
			const w = slotSize, h = slotSize;
			ctx.moveTo(x0 + r, y0);
			ctx.lineTo(x0 + w - r, y0);
			ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
			ctx.lineTo(x0 + w, y0 + h - r);
			ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
			ctx.lineTo(x0 + r, y0 + h);
			ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
			ctx.lineTo(x0, y0 + r);
			ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
			ctx.closePath();
			ctx.fillStyle = 'rgba(0,0,0,0.28)';
			ctx.fill();
			ctx.lineWidth = 2;
			ctx.strokeStyle = '#000000';
			ctx.stroke();
			// Selection/hover rim (from ui.js)
			if (isSelected) {
				ctx.lineWidth = 3;
				ctx.strokeStyle = '#88dd88'; // Green for selected
				ctx.stroke();
			} else if (isHovered) {
				ctx.lineWidth = 3;
				ctx.strokeStyle = '#8ecaff'; // Blue for hover
				ctx.stroke();
			}
			ctx.restore();
		};

		// Draw items in centered grid (no section labels)
		for (let i = 0; i < this.inventory.length; i++) {
			const item = this.inventory[i];
			const row = Math.floor(i / itemsPerRow);
			const col = i % itemsPerRow;
			
			const x0 = startX + col * (slotSize + gap);
			const y0 = startY + row * rowSpacing;

			// Store rect for click detection
			this.itemRects[i] = { x: x0, y: y0, w: slotSize, h: slotSize };

			const isSelected = this.selectedItems && this.selectedItems.indexOf(i) >= 0;
			const isHovered = i === this.hoveredItemIndex;
			const isSold = item.sold;
			const isPlaceholder = item.placeholder;

			// Draw the rounded square slot
			drawSlot(x0, y0, isHovered, isSelected);

			// Draw content inside slot
			const iconCx = x0 + slotSize / 2;
			const iconCy = y0 + slotSize / 2 - 8; // Nudge up for label

			if (isPlaceholder) {
				// Lock icon
				this._drawLockIcon(ctx, iconCx, iconCy + 8, 12);
				ctx.fillStyle = '#888';
				ctx.font = 'bold 11px monospace';
				ctx.textAlign = 'center';
				ctx.fillText(item.label || 'Locked', iconCx, y0 + slotSize - 10);
			} else if (isSold) {
				// SOLD text
				ctx.fillStyle = '#888';
				ctx.font = 'bold 14px monospace';
				ctx.textAlign = 'center';
				ctx.fillText('SOLD', iconCx, iconCy + 8);
			} else {
				// Draw hex icon (exact from ui.js lines 633-656)
				const r = 14;
				const color = item.color || '#888';
				ctx.save();
				ctx.shadowColor = color;
				ctx.shadowBlur = 12;
				ctx.fillStyle = color;
				ctx.strokeStyle = '#000000';
				ctx.lineWidth = 2;
				ctx.beginPath();
				for (let k = 0; k < 6; k++) {
					const a = Math.PI / 3 * k + Math.PI / 6;
					const px = iconCx + Math.cos(a) * r;
					const py = iconCy + Math.sin(a) * r;
					if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
				}
				ctx.closePath();
				ctx.fill();
				ctx.stroke();
				ctx.restore();

				// Draw label text (exact from ui.js lines 658-671)
				const label = item.label || item.type || '???';
				ctx.save();
				ctx.font = '11px monospace';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'top';
				ctx.fillStyle = 'rgba(0,0,0,0.6)';
				ctx.fillText(label, iconCx + 1, y0 + slotSize - 24 + 1);
				ctx.fillStyle = color;
				ctx.fillText(label, iconCx, y0 + slotSize - 24);
				ctx.restore();

				// Price below slot (centered with icon)
				const priceY = y0 + slotSize + 12;
				const currency = item.currency || 'ducats';
				
				if (currency === 'vp') {
					// Draw VP icon for VP-priced items
					this._drawVPIcon(ctx, iconCx - 15, priceY - 8, 8);
					ctx.fillStyle = '#ffec8b';
					ctx.font = 'bold 11px monospace';
					ctx.textAlign = 'left';
					ctx.textBaseline = 'middle';
					ctx.fillText(item.price.toString(), iconCx + 3, priceY + 1);
				} else {
					// Draw ducat icon for ducat-priced items
					this._drawDucatIcon(ctx, iconCx - 15, priceY);
					ctx.fillStyle = '#ffd36b';
					ctx.font = 'bold 11px monospace';
					ctx.textAlign = 'left';
					ctx.textBaseline = 'middle';
					ctx.fillText(item.price.toString(), iconCx, priceY + 1);
				}
			}
		}
	}
	
	_drawHexIcon(ctx, centerX, centerY, size, fillColor, strokeColor, highlight) {
		ctx.save();
		ctx.fillStyle = fillColor;
		ctx.strokeStyle = highlight ? '#ffd700' : strokeColor;
		ctx.lineWidth = highlight ? 3 : 2;
		
		const radius = size / 2.2;
		ctx.beginPath();
		for (let i = 0; i < 6; i++) {
			const angle = (Math.PI / 3) * i;
			const x = centerX + radius * Math.cos(angle);
			const y = centerY + radius * Math.sin(angle);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}
	
	_drawRoundedRect(ctx, x, y, width, height, radius) {
		ctx.beginPath();
		ctx.moveTo(x + radius, y);
		ctx.lineTo(x + width - radius, y);
		ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
		ctx.lineTo(x + width, y + height - radius);
		ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
		ctx.lineTo(x + radius, y + height);
		ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
		ctx.lineTo(x, y + radius);
		ctx.quadraticCurveTo(x, y, x + radius, y);
		ctx.closePath();
	}

	_drawLockIcon(ctx, centerX, centerY, size) {
		ctx.save();
		ctx.strokeStyle = '#888';
		ctx.fillStyle = '#555';
		ctx.lineWidth = 2;

		// Shackle (top arc)
		ctx.beginPath();
		ctx.arc(centerX, centerY - size * 0.15, size * 0.3, Math.PI, 0, false);
		ctx.stroke();

		// Body (rectangle)
		ctx.fillRect(centerX - size * 0.35, centerY - size * 0.15, size * 0.7, size * 0.5);
		ctx.strokeRect(centerX - size * 0.35, centerY - size * 0.15, size * 0.7, size * 0.5);

		// Keyhole
		ctx.fillStyle = '#222';
		ctx.beginPath();
		ctx.arc(centerX, centerY + size * 0.02, size * 0.08, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillRect(centerX - size * 0.04, centerY + size * 0.02, size * 0.08, size * 0.15);

		ctx.restore();
	}

	_drawBottomControls(ctx, boxX, bottomY, boxWidth, player) {
		const barHeight = 60;
		const buttonWidth = 120;
		const buttonHeight = 40;
		const buttonSpacing = 20;

		// Draw button bar background
		ctx.fillStyle = 'rgba(20, 15, 10, 0.9)';
		ctx.fillRect(boxX, bottomY, boxWidth, barHeight);
		ctx.strokeStyle = '#8b7355';
		ctx.lineWidth = 2;
		ctx.strokeRect(boxX, bottomY, boxWidth, barHeight);

		// Calculate totals per currency type from all selected items
		let totalDucats = 0;
		let totalVP = 0;
		if (this.selectedItems && this.selectedItems.length > 0) {
			for (const index of this.selectedItems) {
				if (index >= 0 && index < this.inventory.length) {
					const item = this.inventory[index];
					if (item && !item.sold && !item.placeholder) {
						const currency = item.currency || 'ducats';
						if (currency === 'vp') {
							totalVP += item.price || 0;
						} else {
							totalDucats += item.price || 0;
						}
					}
				}
			}
		}

		// Total display with currency icons (using exact UI icons)
		const totalX = boxX + 30;
		const totalY = bottomY + barHeight / 2;
		
		ctx.fillStyle = '#f4e4c1';
		ctx.font = 'bold 18px serif';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		ctx.fillText('Total:', totalX, totalY);
		
		// Display both currencies if needed
		if (totalVP > 0 && totalDucats > 0) {
			// Both currencies
			this._drawVPIcon(ctx, totalX + 60, totalY - 8, 8);
			ctx.fillStyle = '#ffec8b';
			ctx.font = 'bold 16px monospace';
			ctx.fillText(totalVP.toString(), totalX + 78, totalY);
			
			this._drawDucatIcon(ctx, totalX + 110, totalY);
			ctx.fillStyle = '#ffd36b';
			ctx.fillText(totalDucats.toString(), totalX + 122, totalY);
		} else if (totalVP > 0) {
			// Only VP
			this._drawVPIcon(ctx, totalX + 60, totalY - 8, 8);
			ctx.fillStyle = '#ffec8b';
			ctx.font = 'bold 20px monospace';
			ctx.fillText(totalVP.toString(), totalX + 78, totalY);
		} else {
			// Only ducats (or nothing)
			this._drawDucatIcon(ctx, totalX + 60, totalY);
			ctx.fillStyle = '#ffd36b';
			ctx.font = 'bold 20px monospace';
			ctx.fillText(totalDucats.toString(), totalX + 72, totalY);
		}

		// Cancel button
		const cancelX = boxX + boxWidth - buttonWidth * 2 - buttonSpacing - 30;
		const cancelY = bottomY + (barHeight - buttonHeight) / 2;
		this.cancelButtonRect = { x: cancelX, y: cancelY, w: buttonWidth, h: buttonHeight };

		ctx.fillStyle = this.hoveredButton === 'cancel' ? 'rgba(100, 100, 100, 0.9)' : 'rgba(70, 70, 70, 0.8)';
		ctx.fillRect(cancelX, cancelY, buttonWidth, buttonHeight);
		ctx.strokeStyle = '#000';
		ctx.lineWidth = 2;
		ctx.strokeRect(cancelX, cancelY, buttonWidth, buttonHeight);

		ctx.fillStyle = '#fff';
		ctx.font = 'bold 18px serif';
		ctx.textAlign = 'center';
		ctx.fillText('Cancel', cancelX + buttonWidth / 2, cancelY + buttonHeight / 2);

		// Buy button
		const buyX = boxX + boxWidth - buttonWidth - 30;
		const buyY = bottomY + (barHeight - buttonHeight) / 2;
		this.buyButtonRect = { x: buyX, y: buyY, w: buttonWidth, h: buttonHeight };

		const hasSelection = this.selectedItems && this.selectedItems.length > 0;
		// Check if player has enough of each currency type
		const hasEnoughDucats = totalDucats === 0 || (player?.ducats || 0) >= totalDucats;
		const hasEnoughVP = totalVP === 0 || (player?.victoryPoints || 0) >= totalVP;
		const canBuy = hasSelection && (totalDucats > 0 || totalVP > 0) && hasEnoughDucats && hasEnoughVP;
		const buyEnabled = canBuy;

		if (buyEnabled) {
			ctx.fillStyle = this.hoveredButton === 'buy' ? 'rgba(70, 140, 70, 0.9)' : 'rgba(50, 120, 50, 0.8)';
		} else {
			ctx.fillStyle = 'rgba(50, 50, 50, 0.5)';
		}
		ctx.fillRect(buyX, buyY, buttonWidth, buttonHeight);
		ctx.strokeStyle = '#000';
		ctx.lineWidth = 2;
		ctx.strokeRect(buyX, buyY, buttonWidth, buttonHeight);

		ctx.fillStyle = buyEnabled ? '#fff' : '#666';
		ctx.font = 'bold 18px serif';
		ctx.textAlign = 'center';
		ctx.fillText('Buy', buyX + buttonWidth / 2, buyY + buttonHeight / 2);

		// Insufficient funds warning
		if (hasSelection && (totalDucats > 0 || totalVP > 0)) {
			const insufficientDucats = totalDucats > 0 && (player?.ducats || 0) < totalDucats;
			const insufficientVP = totalVP > 0 && (player?.victoryPoints || 0) < totalVP;
			
			if (insufficientDucats && insufficientVP) {
				ctx.fillStyle = '#ff6666';
				ctx.font = '14px monospace';
				ctx.textAlign = 'center';
				ctx.fillText('Insufficient VP and ducats', boxX + boxWidth / 2, bottomY - 5);
			} else if (insufficientVP) {
				ctx.fillStyle = '#ff6666';
				ctx.font = '14px monospace';
				ctx.textAlign = 'center';
				ctx.fillText('Insufficient Victory Points', boxX + boxWidth / 2, bottomY - 5);
			} else if (insufficientDucats) {
				ctx.fillStyle = '#ff6666';
				ctx.font = '14px monospace';
				ctx.textAlign = 'center';
				ctx.fillText('Insufficient ducats', boxX + boxWidth / 2, bottomY - 5);
			}
		}
	}

	_easeOutCubic(t) {
		return 1 - Math.pow(1 - t, 3);
	}
}

window.MerchantShop = MerchantShop;

