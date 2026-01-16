class DialogueBox {
	constructor() {
		this.open = false;
		this.title = 'Conversation';
		this.lines = [];
		this.closeRect = null;
		this.animTime = 0;
		this.animDuration = 0.25;
		// Typewriter effect state
		this.typeTime = 0;
		this.typeSpeed = 45; // chars per second
		// Dialogue tree state
		this.nodes = null; // { key: { lines: string[], choices: [{text,next}], effects?: any[] } }
		this.currentNodeKey = null;
		this.choiceRects = [];
		this.hoveredChoice = -1;
		// Press state
		this.pressedChoice = -1;
	}

	openWith(options) {
		this.title = options?.title || 'Conversation';
		this.nodes = (options && options.nodes && typeof options.nodes === 'object') ? options.nodes : null;
		this.currentNodeKey = null;
		this.choiceRects = [];
		this.hoveredChoice = -1;
		this.pressedChoice = -1;
		if (this.nodes) {
			const start = options?.start || 'start';
			this._activateNode(start);
		} else {
			this.lines = Array.isArray(options?.lines) ? options.lines.slice(0, 10) : [];
		}
		this.open = true;
		this.animTime = 0;
		this.typeTime = 0;
		if (typeof options?.typeSpeed === 'number' && options.typeSpeed > 0) this.typeSpeed = options.typeSpeed;
	}

	_activateNode(key) {
		try {
			if (!this.nodes || !this.nodes[key]) return;
			this.currentNodeKey = key;
			const node = this.nodes[key];
			this.lines = Array.isArray(node.lines) ? node.lines.slice(0, 10) : [];
			this.choiceRects = [];
			this.hoveredChoice = -1;
			this.pressedChoice = -1;
			this.typeTime = 0;
			// Apply effects on node entry (e.g., npcAction)
			this._applyEffects(node.effects);
		} catch(_) {}
	}

	onMouseMove(mx, my) {
		if (!this.open) return;
		let hover = -1;
		for (let i = 0; i < this.choiceRects.length; i++) {
			const r = this.choiceRects[i];
			if (!r) continue;
			if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) { hover = i; break; }
		}
		this.hoveredChoice = hover;
	}

	onMouseDown(mx, my) {
		if (!this.open) return false;
		// Record pressed choice; selection will occur on mouseup if still inside
		for (let i = 0; i < this.choiceRects.length; i++) {
			const r = this.choiceRects[i];
			if (!r) continue;
			if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
				this.pressedChoice = i;
				return true;
			}
		}
		return false;
	}

	onMouseUp(mx, my) {
		if (!this.open) return false;
		const i = this.pressedChoice;
		this.pressedChoice = -1;
		if (i < 0) return false;
		const r = this.choiceRects[i];
		if (!r) return false;
		if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
			this._selectChoiceIndex(i);
			return true;
		}
		return false;
	}

	onDigitPress(zeroBasedIndex) {
		if (!this.open) return;
		const idx = Math.max(0, Math.floor(zeroBasedIndex));
		if (idx < this.choiceRects.length) {
			this._selectChoiceIndex(idx);
		}
	}

	onDigitDown(zeroBasedIndex) {
		if (!this.open) return;
		const idx = Math.max(0, Math.floor(zeroBasedIndex));
		if (idx < this.choiceRects.length) {
			this.pressedChoice = idx;
		}
	}

	onDigitUp(zeroBasedIndex) {
		if (!this.open) { this.pressedChoice = -1; return; }
		const idx = Math.max(0, Math.floor(zeroBasedIndex));
		const pressed = this.pressedChoice;
		this.pressedChoice = -1;
		if (idx < this.choiceRects.length && pressed === idx) {
			this._selectChoiceIndex(idx);
		}
	}

	_applyEffects(effects) {
		try {
			if (!Array.isArray(effects)) return;
			window.dialogueFlags = window.dialogueFlags || {};
			for (let i = 0; i < effects.length; i++) {
				const eff = effects[i];
				if (!eff || typeof eff !== 'object') continue;
				if (eff.type === 'setFlag' && eff.key) {
					// Special handling for level selection - must be server-authoritative
					if (eff.key === 'selectedLevel' && window.networkManager && window.networkManager.connected) {
						// Send to server instead of setting locally
						console.log('[Dialogue] Sending level selection to server:', eff.value);
						window.networkManager.socket.emit('setLevelType', { levelType: eff.value });
						// Also update local flag for UI consistency
						window.dialogueFlags[eff.key] = eff.value;
					} else {
						// Normal flag setting
						window.dialogueFlags[eff.key] = eff.value;
					}
				}
				// Handle NPC action effects for multiplayer
				if (eff.type === 'npcAction') {
					if (eff.action === 'follow') {
						// In multiplayer, tell server to make NPC follow this player
						if (window.networkManager && window.networkManager.connected && this.npc) {
							window.networkManager.socket.emit('npcSetState', {
								npcId: this.npc.id,
								state: 'follow',
								playerId: window.networkManager.playerId
							});
							console.log('[Dialogue] Requesting server to set NPC follow state');
						} else if (this.npc && typeof this.npc.switchState === 'function') {
							// Single player: direct call
							this.npc.switchState('follow');
						}
					} else if (eff.action === 'default' || eff.action === 'idle') {
						if (window.networkManager && window.networkManager.connected && this.npc) {
							window.networkManager.socket.emit('npcSetState', {
								npcId: this.npc.id,
								state: 'idle',
								playerId: window.networkManager.playerId
							});
						} else if (this.npc && typeof this.npc.switchState === 'function') {
							this.npc.switchState('idle');
						}
					} else if (eff.action === 'hostile') {
						// Hostile state (from Mammon dialogue path)
						if (window.networkManager && window.networkManager.connected && this.npc) {
							window.networkManager.socket.emit('npcSetState', {
								npcId: this.npc.id,
								state: 'hostile',
								playerId: window.networkManager.playerId
							});
							console.log('[Dialogue] Requesting server to set NPC hostile state');
						} else if (this.npc && typeof this.npc.switchState === 'function') {
							this.npc.switchState('hostile');
						}
					} else if (eff.action === 'betrayed') {
						// Betrayed state (intermediate before hostile)
						if (window.networkManager && window.networkManager.connected && this.npc) {
							window.networkManager.socket.emit('npcSetState', {
								npcId: this.npc.id,
								state: 'betrayed',
								playerId: window.networkManager.playerId
							});
							console.log('[Dialogue] Requesting server to set NPC betrayed state');
						} else if (this.npc && typeof this.npc.switchState === 'function') {
							this.npc.switchState('betrayed');
						}
					} else if (eff.action === 'run_to_boss') {
						// Run to boss state
						if (window.networkManager && window.networkManager.connected && this.npc) {
							window.networkManager.socket.emit('npcSetState', {
								npcId: this.npc.id,
								state: 'run_to_boss',
								playerId: window.networkManager.playerId
							});
							console.log('[Dialogue] Requesting server to set NPC run_to_boss state');
						} else if (this.npc && typeof this.npc.switchState === 'function') {
							this.npc.switchState('run_to_boss');
						}
					}
					
					// Also forward to global handler for any additional processing
					if (typeof window.onNpcDialogueAction === 'function') {
						try { window.onNpcDialogueAction(eff, { npcId: this.npcId ?? null, node: this.currentNodeKey || null, title: this.title || null }); } catch(_) {}
					}
				}
			}
		} catch(err) {
			console.error('[Dialogue] Error applying effects:', err);
		}
	}

	_selectChoiceIndex(index) {
		try {
			if (!this.nodes || !this.currentNodeKey) return;
			const node = this.nodes[this.currentNodeKey];
			if (!node || !Array.isArray(node.choices)) return;
			const choice = node.choices[index];
			if (!choice) return;
			
			// Special handling for merchant shop
			if (this.npc && this.npc.name === 'Merchant' && choice.next === 'wares') {
				// Open shop instead of showing sub-dialogue
				if (window.merchantShop) {
					this.open = false;
					window.merchantShop.openShop();
					console.log('[Dialogue] Opening merchant shop');
				}
				return;
			}
			
			// Apply node-level effects before transition
			this._applyEffects(node.effects);
			if (choice.next && this.nodes[choice.next]) {
				this._activateNode(choice.next);
				return;
			}
			// No next: close dialog
			this.open = false;
		} catch(_) {}
	}

	tryCloseAtMouse(canvas, mx, my) {
		if (!this.open || !this.closeRect) return false;
		const b = this.closeRect;
		if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
			this.open = false;
			return true;
		}
		return false;
	}

	update(dt) {
		if (!this.open) return;
		this.animTime += Math.max(0, dt || 0);
		if (this.animTime > this.animDuration) this.animTime = this.animDuration;
		this.typeTime += Math.max(0, dt || 0);
	}

	draw(ctx, viewportWidth, viewportHeight) {
		if (!this.open) return;
		const w = Math.min(780, Math.round(viewportWidth * 0.9));
		const h = Math.min(280, Math.round(viewportHeight * 0.35));
		const x = Math.round((viewportWidth - w) / 2);
		const marginBottom = 24;
		const y = Math.max(0, Math.round(viewportHeight - h - marginBottom));
		ctx.save();
		// No backdrop dim (keep world visible under dialog)
		// Panel (50% transparent dark grey)
		const p = Math.max(0, Math.min(1, (this.animDuration > 0 ? (this.animTime / this.animDuration) : 1)));
		const ease = 1 - Math.pow(1 - p, 3);
		const alpha = 0.2 + 0.8 * ease;
		const scale = 0.95 + 0.05 * ease;
		const yOffset = -12 * (1 - ease);
		ctx.globalAlpha = alpha;
		ctx.translate(x + w / 2, y + h / 2 + yOffset);
		ctx.scale(scale, scale);
		ctx.translate(-(x + w / 2), -(y + h / 2 + yOffset));
		ctx.fillStyle = 'rgba(0,0,0,0.5)';
		ctx.strokeStyle = '#000000';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.rect(x + 0.5, y + 0.5 + yOffset, w, h);
		ctx.fill();
		ctx.stroke();
		// Title
		ctx.fillStyle = '#ffffff';
		ctx.font = 'bold 20px sans-serif';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		ctx.fillText(this.title, x + 16, y + 12 + yOffset);
		// Body text (typewriter effect) with word wrap to fit inside panel
		ctx.font = '16px sans-serif';
		ctx.fillStyle = '#e2e5ee';
		// Robust wrapper: greedily fit as many characters as possible per line, breaking at whitespace when available
		const wrapLine = (text, maxWidth) => {
			const s = String(text || '');
			const result = [];
			let start = 0;
			while (start < s.length) {
				let end = start;
				let lastSpace = -1;
				let line = '';
				while (end < s.length) {
					const ch = s[end];
					if (ch === ' ' || ch === '\t') lastSpace = end;
					const test = s.substring(start, end + 1);
					if (ctx.measureText(test).width > maxWidth) {
						// Exceeded: break at last space if any, else hard break at current end-1
						if (lastSpace > start) { end = lastSpace; }
						else { end = Math.max(start + 1, end); }
						line = s.substring(start, end).trim();
						break;
					}
					end++;
				}
				if (!line) { line = s.substring(start, end).trim(); }
				if (line.length === 0) { // skip leading whitespace
					start = end + 1;
					continue;
				}
				result.push(line);
				start = (line.length + start);
				// Skip one space if we broke at a space
				if (start < s.length && s[start] === ' ') start++;
			}
			return result;
		};
		const bodyMaxW = w - 32;
		let wrappedBody = [];
		for (let i = 0; i < this.lines.length; i++) {
			const segs = wrapLine(String(this.lines[i] ?? ''), bodyMaxW);
			for (let k = 0; k < segs.length; k++) {
				if (wrappedBody.length >= 10) break;
				wrappedBody.push(segs[k]);
			}
			if (wrappedBody.length >= 10) break;
		}
		{
			const speed = Math.max(1, this.typeSpeed || 45);
			const budget = Math.floor((this.typeTime || 0) * speed);
			let remaining = budget;
			for (let i = 0; i < wrappedBody.length; i++) {
				const full = String(wrappedBody[i] ?? '');
				if (remaining <= 0) break;
				const take = Math.min(remaining, full.length);
				const shown = full.substring(0, take);
				ctx.fillText(shown, x + 16, y + 52 + i * 22 + yOffset);
				remaining -= take;
			}
		}
		// Choices list
		this.choiceRects = [];
		if (this.nodes && this.currentNodeKey && this.nodes[this.currentNodeKey]) {
			const node = this.nodes[this.currentNodeKey];
			if (Array.isArray(node.choices) && node.choices.length > 0) {
				ctx.font = '16px sans-serif';
				ctx.textBaseline = 'top';
				const startY = y + 52 + Math.max(wrappedBody.length, 1) * 22 + 10 + yOffset;
				const wrap = (t, maxW) => wrapLine(t, maxW);
				let cursorY = startY;
				for (let i = 0; i < node.choices.length; i++) {
					const label = `${i + 1}. ${String(node.choices[i]?.text || '')}`;
					const lines = wrap(label, w - 32);
					const tx = x + 16;
					const ty = cursorY;
					let widest = 0;
					for (let li = 0; li < lines.length; li++) widest = Math.max(widest, Math.ceil(ctx.measureText(lines[li]).width));
					const th = 20;
					const totalH = th * Math.max(1, lines.length);
					const padTop = 4, padBot = 0;
					if (this.hoveredChoice === i) {
						ctx.fillStyle = 'rgba(255,255,255,0.1)';
						ctx.beginPath();
						ctx.rect(tx - 4, ty - padTop, widest + 8, totalH + padTop + padBot);
						ctx.fill();
					}
					if (this.pressedChoice === i) {
						ctx.strokeStyle = '#c8cbd3';
						ctx.lineWidth = 2;
						ctx.beginPath();
						ctx.rect(tx - 4, ty - padTop, widest + 8, totalH + padTop + padBot);
						ctx.stroke();
					}
					ctx.fillStyle = '#dbe0f5';
					for (let li = 0; li < lines.length; li++) ctx.fillText(lines[li], tx, ty + li * th);
					this.choiceRects.push({ x: tx - 4, y: ty - padTop, w: widest + 8, h: totalH + padTop + padBot });
					cursorY += totalH + 4;
				}
			}
		}
		// Close X
		const bx = x + w - 28;
		const by = y + 8;
		const bs = 20;
		// Close button background (very dark grey)
		ctx.fillStyle = '#111111';
		ctx.strokeStyle = '#000000';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.rect(bx + 0.5, by + 0.5 + yOffset, bs, bs);
		ctx.fill();
		ctx.stroke();
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(bx + 5, by + 5 + yOffset);
		ctx.lineTo(bx + bs - 5, by + bs - 5 + yOffset);
		ctx.moveTo(bx + bs - 5, by + 5 + yOffset);
		ctx.lineTo(bx + 5, by + bs - 5 + yOffset);
		ctx.stroke();
		ctx.restore();
		// Store clickable rect for close
		this.closeRect = { x: bx, y: by + yOffset, w: bs, h: bs };
	}
}

window.DialogueBox = DialogueBox;


