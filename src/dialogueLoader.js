(function(){
	class DialogueLoader {
		constructor(basePath = 'dialogue') {
			this.basePath = basePath.replace(/\/$/, '');
			this.cache = new Map();
		}

		_computeBaseName(npcKey) {
			// Strip common prefix like "NPC_" and normalize spaces to underscores
			const raw = String(npcKey || '').trim();
			if (!raw) return null;
			const stripped = raw.replace(/^NPC_/i, '');
			const normalized = stripped.replace(/\s+/g, '_');
			return `npc_${normalized}`;
		}

		buildUrl(npcKey, variant = 'intro') {
			// Map NPC class/name to filename convention: npc_<key>.json
			const baseName = this._computeBaseName(npcKey);
			if (!baseName) return null;
			const file = `${baseName}.json`;
			return `${this.basePath}/${file}`;
		}

		_loadFromInline(npcKey) {
			try {
				const baseName = this._computeBaseName(npcKey);
				if (!baseName) return null;
				const el = document.getElementById(`dialogue-${baseName}`);
				if (!el) return null;
				const txt = el.textContent || el.innerText || '';
				if (!txt) return null;
				return JSON.parse(txt);
			} catch(_) { return null; }
		}

		async load(npcKey, variant = 'intro') {
			try {
				const cacheKey = `${npcKey}::${variant}`;
				if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
				let data = null;
				// Prefer fetch when not running from file://
				if (typeof location !== 'undefined' && location.protocol !== 'file:') {
					let url = this.buildUrl(npcKey, variant);
					if (!url) throw new Error('Invalid NPC key');
					// Always add a cache-busting query in dev to avoid 304 empty body issues
					const bustUrl = url + (url.indexOf('?') === -1 ? '?_ts=' : '&_ts=') + Date.now();
					let res = await fetch(bustUrl, { cache: 'no-store', headers: { 'Accept': 'application/json' } });
					if (res.status === 304 && this.cache.has(cacheKey)) {
						return this.cache.get(cacheKey);
					}
					if (!res.ok) {
						// Retry once more with a different cache-busting token
						const bust2 = url + (url.indexOf('?') === -1 ? '?_ts=' : '&_ts=') + (Date.now() + 1);
						res = await fetch(bust2, { cache: 'no-store', headers: { 'Accept': 'application/json' } });
					}
					if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
					// Parse as text first to improve error diagnostics
					const raw = await res.text();
					try {
						data = JSON.parse(raw);
					} catch(parseErr) {
						try { console.error('[DialogueLoader] JSON parse failed, body preview:', raw.slice(0, 200)); } catch(_) {}
						throw parseErr;
					}
					try { console.log('[DialogueLoader] HTTP loaded', { url, status: res.status, hasNodes: !!data?.nodes, keys: Object.keys(data || {}) }); } catch(_) {}
				} else {
					// file:// protocol: first try XHR, then inline script tag
					const url = this.buildUrl(npcKey, variant);
					if (!url) throw new Error('Invalid NPC key');
					try {
						data = await new Promise((resolve, reject) => {
							try {
								const xhr = new XMLHttpRequest();
								xhr.open('GET', url, true);
								try { xhr.overrideMimeType('application/json'); } catch(_) {}
								xhr.onreadystatechange = function() {
									if (xhr.readyState === 4) {
										try { resolve(JSON.parse(xhr.responseText || '')); } catch(e) { reject(e); }
									}
								};
								xhr.onerror = () => reject(new Error('XHR error'));
								xhr.send();
							} catch (e) { reject(e); }
						});
						try { console.log('[DialogueLoader] XHR loaded', { url, hasNodes: !!data?.nodes, keys: Object.keys(data || {}) }); } catch(_) {}
					} catch (_) {
						data = this._loadFromInline(npcKey);
						if (!data) throw new Error('No inline dialogue found');
						try { console.log('[DialogueLoader] Inline loaded', { id: `dialogue-${this._computeBaseName(npcKey)}`, hasNodes: !!data?.nodes, keys: Object.keys(data || {}) }); } catch(_) {}
					}
				}
				// Normalize into DialogueBox options
				const title = data?.title || String(npcKey || 'NPC');
				let result = null;
				// Optional: normalize barks for NPC state-driven bubble lines
				let barks = null;
				try {
					if (data && typeof data === 'object' && data.barks && typeof data.barks === 'object') {
						barks = {};
						for (const key in data.barks) {
							const cfg = data.barks[key] || {};
							const lines = Array.isArray(cfg.lines)
								? cfg.lines.map((ln) => String(ln ?? '')).filter(s => s && s.length > 0)
								: [];
							const entry = { lines };
							if (typeof cfg.interval === 'number' && cfg.interval > 0) entry.interval = cfg.interval;
							if (typeof cfg.gap === 'number' && cfg.gap >= 0) entry.gap = cfg.gap;
							barks[key] = entry;
						}
					}
				} catch(_) {}
				if (data && typeof data === 'object' && data.nodes && typeof data.nodes === 'object') {
					const nodes = {};
					for (const key in data.nodes) {
						const node = data.nodes[key] || {};
						const nodeLines = Array.isArray(node.lines)
							? node.lines.map((ln) => {
								if (ln && typeof ln === 'object' && 'speaker' in ln && 'text' in ln) {
									return `${ln.speaker}: ${ln.text}`;
								}
								return String(ln ?? '');
							}).filter(s => s && s.length > 0)
							: [];
						const choices = Array.isArray(node.choices) ? node.choices.map(c => ({ text: String(c?.text || ''), next: c?.next || null })) : [];
						const effects = Array.isArray(node.effects) ? node.effects.slice() : [];
						nodes[key] = { lines: nodeLines, choices, effects };
					}
					const start = data.start || 'start';
					result = { title, nodes, start };
					if (barks) result.barks = barks;
				} else {
					const lines = Array.isArray(data?.lines)
						? data.lines.map((ln) => {
							if (ln && typeof ln === 'object' && 'speaker' in ln && 'text' in ln) {
								return `${ln.speaker}: ${ln.text}`;
							}
							return String(ln ?? '');
						}).filter(s => s && s.length > 0)
						: [];
					result = { title, lines };
					if (barks) result.barks = barks;
				}
				try { console.log('[DialogueLoader] Normalized', { title: result.title, hasNodes: !!result.nodes, start: result.start, lineCount: Array.isArray(result.lines) ? result.lines.length : 0, hasBarks: !!result.barks }); } catch(_) {}
				this.cache.set(cacheKey, result);
				return result;
			} catch (e) {
				console.error('[DialogueLoader] load failed:', e);
				return { title: String(npcKey || 'NPC'), lines: ['...'] };
			}
		}
	}

	window.DialogueLoader = DialogueLoader;
})();


