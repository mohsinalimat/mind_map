// mind_map_core.js
// Place in: <app>/public/js/mind_map_core.js
// Load BEFORE mind_map_viewer.js in the page JSON

class MindMapPage {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.doc = null;
		this.tree = null;
		this.selected = null;

		this.vx = 0;
		this.vy = 0;
		this.vscale = 1;
		this.drag = false;
		this.lx = 0;
		this.ly = 0;

		this._autosave_timer = null;
		this._drag_node = null;
		this._popup_node = null;

		this._selected_nodes = new Set();
		this._lasso_active = false;
		this._lasso_start = null;
		this._lasso_rect = { x: 0, y: 0, w: 0, h: 0 };
		this._lasso_drawn = false;

		this._pan_mode = false;
		this._space_held = false;

		this._history = [];
		this._history_index = -1;
		this._history_locked = false;

		// Drag-and-drop reorder state
		this._dnd_node = null;
		this._dnd_over = null;
		this._dnd_indicator = null;
		this._drag_pointer = null;
		this._drag_active = false;
		this._drag_preview = null;
		this._drag_hover_node = null;
		this._drag_click_suppressed = false;

		this._make_toolbar();
		this._make_layout();
	}

	// ── Toolbar ────────────────────────────────────────────────────────────────

	_make_toolbar() {
		const p = this.page;

		this.field_doc = p.add_field({
			fieldname: 'mind_map_name',
			label: __('Mind Map'),
			fieldtype: 'Link',
			options: 'Mind Map',
			change: () => {
				const v = this.field_doc.get_value();
				if (v) this._load(v);
			},
		});

		this.field_theme = p.add_field({
			fieldname: 'theme',
			label: __('Theme'),
			fieldtype: 'Select',
			options: '\nLight\nDark\nAuto',
			change: () => this._apply_theme(),
		});

		this.field_layout = p.add_field({
			fieldname: 'layout',
			label: __('Layout'),
			fieldtype: 'Select',
			options: '\nRight\nTree',
			change: () => {
				this._remember_layout();
				this._re_render();
				if (this.tree) this._fit_view(this.tree);
				if (this.tree) this._mark_dirty();
			},
		});

		p.add_inner_button(__('New'), () => this._new_doc(), __('Mind Map'));
		p.add_inner_button(__('Open'), () => this._open_doc(), __('Mind Map'));

		p.add_inner_button(__('Export PNG'), () => this._export_png(), __('Export'));
		p.add_inner_button(__('Export SVG'), () => this._export_svg(), __('Export'));

		p.add_inner_button(__('Expand All'), () => this._toggle_all(false), __('View'));
		p.add_inner_button(__('Collapse All'), () => this._toggle_all(true), __('View'));

		p.set_primary_action(__('Save'), () => this._save(), 'save');
	}

	_toggle_all(state) {
		const walk = (n) => {
			n.collapsed = state;
			n.children.forEach(c => walk(c));
		};
		walk(this.tree);
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
		this._mark_dirty();
	}

	// ── Layout ─────────────────────────────────────────────────────────────────

	_make_layout() {
		const wrap = $(this.wrapper).find('.page-content, .page-body').first();
		wrap.css({ padding: '0', overflow: 'hidden' });

		wrap.html(`
			<div id="mm-root" style="display:flex;height:calc(100vh - 84px);overflow:hidden;position:relative;background:var(--bg-color)">
				<div id="mm-canvas" style="flex:1;position:relative;overflow:hidden;cursor:default;outline:none;user-select:none" tabindex="0">
					<svg id="mm-svg" style="width:100%;height:100%;display:block;overflow:visible">
						<defs id="mm-defs"></defs>
						<g id="mm-g"></g>
						<rect id="mm-lasso" style="display:none;fill:rgba(83,74,183,0.08);stroke:#534AB7;stroke-width:1.5;stroke-dasharray:5,3;pointer-events:none" rx="3"/>
					</svg>
					<div id="mm-placeholder" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:14px;pointer-events:none">
						Select a Mind Map from the toolbar ↑
					</div>
				</div>
				<div id="mm-ctx" style="display:none;position:fixed;z-index:9999;background:var(--card-bg,#fff);border:1px solid var(--border-color);border-radius:8px;padding:4px 0;box-shadow:0 4px 16px rgba(0,0,0,0.12);font-size:13px"></div>
				<div id="mm-drop-indicator" style="display:none;position:absolute;pointer-events:none;z-index:200;height:3px;border-radius:999px;background:#10B981;box-shadow:0 0 0 1px rgba(255,255,255,0.75),0 0 6px rgba(16,185,129,0.28);transition:top 0.08s"></div>
			</div>

			<div id="mm-footer" style="display:flex;align-items:center;gap:12px;padding:6px 15px;background:var(--card-bg);border-top:1px solid var(--border-color);font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden">
				<span style="display:inline-flex;align-items:center;gap:6px">
					<span>Layout</span>
					<select id="mm-layout-quick" style="height:24px;padding:0 8px;border:1px solid var(--border-color);border-radius:6px;background:var(--card-bg);color:var(--text-color);font-size:11px">
						<option value="Right">Right</option>
						<option value="Tree">Tree</option>
					</select>
				</span>
				<span>·</span>
				<span><kbd>Tab</kbd> Child</span>
				<span>·</span>
				<span><kbd>Shift+Enter</kbd> Sibling</span>
				<span>·</span>
				<span><kbd>F2</kbd> Rename</span>
				<span>·</span>
				<span><kbd>Del</kbd> Delete</span>
				<span>·</span>
				<span><kbd>Space</kbd> Pan</span>
				<span>·</span>
				<span><kbd>Ctrl+Z</kbd> Undo</span>
				<span>·</span>
				<span><kbd>F</kbd> Fit Screen</span>
				<span>·</span>
				<span id="mm-mode-label" style="font-weight:600;color:var(--primary)">✦ Select Mode</span>
				<span id="mm-save-status" style="margin-left:auto;font-weight:700"></span>
				<span id="mm-fit-btn" title="Fit to Screen" style="cursor:pointer;font-size:18px;padding:2px 6px;border-radius:5px;line-height:1;display:inline-flex;align-items:center;justify-content:center;transition:background 0.15s" onmouseenter="this.style.background='var(--border-color)'" onmouseleave="this.style.background='transparent'">⊙</span>
			</div>
		`);

		window._mm = this;
		this._bind_events();
		setTimeout(() => this._restore_last_map(), 400);
	}

	// ── Events ─────────────────────────────────────────────────────────────────

	_bind_events() {
		const cv = document.getElementById('mm-canvas');

		document.getElementById('mm-fit-btn').addEventListener('click', () => {
			if (this.tree) this._fit_view(this.tree);
		});

		document.getElementById('mm-layout-quick').addEventListener('change', (e) => {
			this.field_layout.set_value(e.target.value);
		});

		document.addEventListener('keydown', (e) => {
			if (e.code === 'Space' && !this._space_held && !this._is_editing()) {
				e.preventDefault();
				this._space_held = true;
				this._pan_mode = true;
				cv.style.cursor = 'grab';
				document.getElementById('mm-mode-label').textContent = '✦ Pan Mode';
			}
			if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && !this._is_editing()) {
				e.preventDefault();
				this._undo();
			}
			if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey)) && !this._is_editing()) {
				e.preventDefault();
				this._redo();
			}
			if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !this._is_editing()) {
				e.preventDefault();
				if (this.tree) this._fit_view(this.tree);
			}
		});

		document.addEventListener('keyup', (e) => {
			if (e.code === 'Space') {
				this._space_held = false;
				this._pan_mode = false;
				cv.style.cursor = 'default';
				document.getElementById('mm-mode-label').textContent = '✦ Select Mode';
			}
		});

		cv.addEventListener('mousedown', e => {
			// Only handle left-click on blank canvas (not right-click, not on a node)
			if (e.button !== 0) return;
			if (e.target.closest('.mm-node')) return;
			this._hide_ctx();

			if (this._pan_mode) {
				this.drag = true;
				this.lx = e.clientX;
				this.ly = e.clientY;
				cv.style.cursor = 'grabbing';
			} else {
				if (!e.shiftKey) {
					this._clear_multi_select();
					this._deselect();
				}
				const rect = cv.getBoundingClientRect();
				const sx = (e.clientX - rect.left - this.vx) / this.vscale;
				const sy = (e.clientY - rect.top - this.vy) / this.vscale;
				this._lasso_active = true;
				this._lasso_drawn = false;
				this._lasso_start = { x: e.clientX - rect.left, y: e.clientY - rect.top, sx, sy };
				this._lasso_rect = { x: sx, y: sy, w: 0, h: 0 };
				document.getElementById('mm-lasso').style.display = 'none';
			}
		});

		// Right-click on canvas: allow native browser context menu, hide our custom ctx
		cv.addEventListener('contextmenu', e => {
			if (e.target.closest('.mm-node')) return; // node ctx handled in draw_nodes
			this._hide_ctx();
			// Do NOT e.preventDefault() here — let browser native menu show
		});

		window.addEventListener('mouseup', () => {
			if (this.drag) {
				this.drag = false;
				cv.style.cursor = this._pan_mode ? 'grab' : 'default';
			}
			if (this._drag_pointer) {
				this._finish_node_drag();
			}
			if (this._lasso_active) {
				this._lasso_active = false;
				document.getElementById('mm-lasso').style.display = 'none';
				if (this._lasso_drawn) {
					this._finalize_lasso();
				}
				this._lasso_drawn = false;
			}
		});

		window.addEventListener('mousemove', e => {
			if (this.drag && this._pan_mode) {
				this.vx += e.clientX - this.lx;
				this.vy += e.clientY - this.ly;
				this.lx = e.clientX;
				this.ly = e.clientY;
				this._apply_transform();
			}
			if (this._drag_pointer) {
				this._update_node_drag(e);
			}
			if (this._lasso_active) {
				const rect = cv.getBoundingClientRect();
				const cx = e.clientX - rect.left;
				const cy = e.clientY - rect.top;
				const lx0 = this._lasso_start.x;
				const ly0 = this._lasso_start.y;
				const lasso = document.getElementById('mm-lasso');
				const rx = Math.min(cx, lx0);
				const ry = Math.min(cy, ly0);
				const rw = Math.abs(cx - lx0);
				const rh = Math.abs(cy - ly0);
				if (rw > 5 || rh > 5) {
					this._lasso_drawn = true;
					lasso.style.display = 'block';
					lasso.setAttribute('x', rx);
					lasso.setAttribute('y', ry);
					lasso.setAttribute('width', rw);
					lasso.setAttribute('height', rh);
					this._lasso_rect = {
						x: (rx - this.vx) / this.vscale,
						y: (ry - this.vy) / this.vscale,
						w: rw / this.vscale,
						h: rh / this.vscale
					};
				}
			}
		});

		cv.addEventListener('wheel', e => {
			e.preventDefault();
			const factor = e.deltaY < 0 ? 1.1 : 0.9;
			const newScale = Math.min(4, Math.max(0.1, this.vscale * factor));
			const rect = cv.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			this.vx = mx - (mx - this.vx) * (newScale / this.vscale);
			this.vy = my - (my - this.vy) * (newScale / this.vscale);
			this.vscale = newScale;
			this._apply_transform();
		}, { passive: false });

		this._bind_keyboard();
	}

	_is_editing() {
		const ae = document.activeElement;
		if (!ae) return false;
		const tag = ae.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || ae.getAttribute('contenteditable') === 'true';
	}

	_bind_keyboard() {
		document.getElementById('mm-canvas').addEventListener('keydown', e => {
			if (this._is_editing()) return;
			if (e.code === 'Space') return;

			if ((e.key === 'Delete' || e.key === 'Backspace') && this._selected_nodes.size > 1) {
				e.preventDefault();
				this._delete_selected_nodes();
				return;
			}

			if (!this.selected) return;

			if (e.key === 'Tab') {
				e.preventDefault();
				this._add_child(this.selected);
			} else if (e.key === 'Enter' && e.shiftKey) {
				e.preventDefault();
				if (this.selected._parent) this._add_sibling(this.selected);
			} else if (e.key === 'F2') {
				e.preventDefault();
				this._start_rename(this.selected);
			} else if (e.key === 'Delete' || e.key === 'Backspace') {
				e.preventDefault();
				this._delete_node(this.selected);
			} else if (e.key === 'Escape') {
				this._deselect();
				this._clear_multi_select();
			}
		});
	}

	// ── Undo / Redo ────────────────────────────────────────────────────────────

	_push_history() {
		if (this._history_locked || !this.tree) return;
		const snap = JSON.stringify(this._serialize(this.tree));
		this._history = this._history.slice(0, this._history_index + 1);
		this._history.push(snap);
		if (this._history.length > 100) this._history.shift();
		this._history_index = this._history.length - 1;
	}

	_undo() {
		if (this._history_index <= 0) return;
		this._history_index--;
		this._restore_history();
	}

	_redo() {
		if (this._history_index >= this._history.length - 1) return;
		this._history_index++;
		this._restore_history();
	}

	_restore_history() {
		this._history_locked = true;
		const snap = JSON.parse(this._history[this._history_index]);
		this.tree = this._build(snap, null);
		this._re_render();
		this._set_save_status('● Unsaved');
		this._history_locked = false;
	}

	// ── Transform ──────────────────────────────────────────────────────────────

	_apply_transform() {
		const g = document.getElementById('mm-g');
		if (g) g.setAttribute('transform', `translate(${this.vx},${this.vy}) scale(${this.vscale})`);
	}

	// ── Load / Render ──────────────────────────────────────────────────────────

	_load(name) {
		frappe.call({
			method: 'frappe.client.get',
			args: { doctype: 'Mind Map', name },
			callback: r => {
				if (!r.message) return;
				this.doc = r.message;
				localStorage.setItem('mm_last_map', name);
				this._render(r.message.map_json || '{}');
			},
		});
	}

	_render(json_str) {
		let data;
		try { data = JSON.parse(json_str); } catch (e) { data = { label: 'Mind Map Root' }; }
		const savedLayout = data.layout || this._get_saved_layout();
		if (savedLayout === 'Right' || savedLayout === 'Tree') {
			this.field_layout.set_value(savedLayout);
		}
		document.getElementById('mm-placeholder').style.display = 'none';
		this.tree = this._build(data, null);
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
		this._fit_view(this.tree);
		this._history = [JSON.stringify(this._serialize(this.tree))];
		this._history_index = 0;
	}

	_re_render() {
		if (!this.tree) return;
		const quickLayout = document.getElementById('mm-layout-quick');
		if (quickLayout) quickLayout.value = this.field_layout?.get_value() || 'Right';
		const g = document.getElementById('mm-g');
		const defs = document.getElementById('mm-defs');
		g.innerHTML = '';
		defs.innerHTML = '';
		this._layout(this.tree);
		this._draw_edges(g, this.tree);
		this._draw_nodes(g, this.tree);

		if (this.selected) {
			const f = this._find_by_id(this.tree, this.selected._id);
			if (f) this._select(f);
		}
		this._selected_nodes.forEach(id => {
			const n = this._find_by_id(this.tree, id);
			if (n) this._highlight_multi(n, true);
		});
	}

	// ── Tree Build ─────────────────────────────────────────────────────────────

	_build(data, parent, depth = 0) {
		const n = {
			label: (data.label !== undefined && data.label !== null) ? String(data.label) : 'Node',
			note: data.note || '',
			depth,
			collapsed: !!data.collapsed,
			tree_side: data.tree_side || null,
			_parent: parent,
			_id: data._id || Math.random().toString(36).slice(2, 9),
			children: [],
			x: 0,
			y: 0
		};
		const kids = data.child || data.children || [];
		n.children = kids.map(k => this._build(k, n, depth + 1));
		return n;
	}

	// ── Layout ─────────────────────────────────────────────────────────────────

	_layout(root) {
		const mode = this.field_layout?.get_value() || 'Right';
		const gapX = 80;
		const gapY = 50;

		// Pre-calculate widths for all nodes
		const preWidth = (n) => {
			n.w = this._get_node_width(n.label, n.depth);
			n.children.forEach(preWidth);
		};
		preWidth(root);

		// Count visible subtree height
		const getSize = (node) => {
			if (node.collapsed || !node.children.length) return 1;
			return node.children.reduce((s, c) => s + getSize(c), 0);
		};

		if (mode === 'Tree') {
			// ── Tree (bidirectional) layout ──────────────────────────────────
			const rootChildren = [...root.children];
			const left = [];
			const right = [];
			rootChildren.forEach((node, index) => {
				if (!node.tree_side) {
					node.tree_side = index % 2 === 0 ? 'right' : 'left';
				}
				if (node.tree_side === 'left') left.push(node);
				else right.push(node);
			});
			const leftSize = left.reduce((sum, node) => sum + getSize(node), 0);
			const rightSize = right.reduce((sum, node) => sum + getSize(node), 0);

			// solveDir: lay out a subtree recursively
			// dir='right': children placed to right of n  (childX = n.x + n.w + gapX)
			// dir='left':  children placed to left of n   (childX = n.x - gapX - child.w)
			const solveDir = (n, x, y0, dir) => {
				n.x = x;
				if (n.collapsed || !n.children.length) {
					n.y = y0;
					return y0 + gapY;
				}
				let cur = y0;
				n.children.forEach(c => {
					const childX = dir === 'left'
						? n.x - gapX - c.w
						: n.x + n.w + gapX;
					cur = solveDir(c, childX, cur, dir);
				});
				n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
				return cur;
			};

			// First pass: compute total vertical span to center root
			// We need both sides to start from the same Y top
			// Estimate total leaf count
			const totalLeaves = Math.max(leftSize + rightSize, 1);
			const startY = -(totalLeaves * gapY) / 2;

			let leftY = startY;
			let rightY = startY;

			// Layout right side
			right.forEach(c => { rightY = solveDir(c, root.w + gapX, rightY, 'right'); });
			// Layout left side (each child's own width used for its x)
			left.forEach(c => { leftY = solveDir(c, -(gapX + c.w), leftY, 'left'); });

			// Center root vertically between the first and last direct children
			root.x = 0;
			const allDirect = [...right, ...left];
			if (allDirect.length > 0) {
				const ys = allDirect.map(c => c.y);
				root.y = (Math.min(...ys) + Math.max(...ys)) / 2;
			} else {
				root.y = 0;
			}

		} else {
			// ── Right (flow right) layout ────────────────────────────────────
			const solve = (n, x, y0) => {
				n.x = x;
				if (n.collapsed || !n.children.length) {
					n.y = y0;
					return y0 + gapY;
				}
				const childX = x + n.w + gapX;
				let cur = y0;
				n.children.forEach(c => { cur = solve(c, childX, cur); });
				n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
				return cur;
			};
			solve(root, 0, 0);
		}
	}

	// ── Colors ─────────────────────────────────────────────────────────────────

	_colors() {
		return ['#5B54D6', '#1E88E5', '#00897B', '#E65100', '#6A1B9A', '#2E7D32'];
	}

	_get_font_family() {
		const root = document.getElementById('mm-root');
		const cssFamily = root ? getComputedStyle(root).getPropertyValue('font-family').trim() : '';
		return cssFamily || 'Verdana, sans-serif';
	}

	_measure_text_width(text, depth = 1) {
		const canvas = this._measure_canvas || (this._measure_canvas = document.createElement('canvas'));
		const ctx = canvas.getContext('2d');
		if (!ctx) return (text || '').length * 9.5;
		const fontSize = depth === 0 ? 16 : 14;
		const fontWeight = depth === 0 ? '700' : '500';
		ctx.font = `${fontWeight} ${fontSize}px ${this._get_font_family()}`;
		return ctx.measureText(text || '').width;
	}

	_get_node_width(text, depth = 1) {
		const measured = this._measure_text_width(text, depth);
		const horizontalPadding = depth === 0 ? 32 : 26;
		return Math.max(Math.ceil(measured + horizontalPadding), 80);
	}

	_mix_colors(col1, col2, ratio = 0.5) {
		const parseHex = (hex) => {
			const clean = (hex || '').replace('#', '');
			if (clean.length !== 6) return [0, 0, 0];
			return [
				parseInt(clean.slice(0, 2), 16),
				parseInt(clean.slice(2, 4), 16),
				parseInt(clean.slice(4, 6), 16),
			];
		};
		const [r1, g1, b1] = parseHex(col1);
		const [r2, g2, b2] = parseHex(col2);
		const mix = (a, b) => Math.round(a + (b - a) * ratio).toString(16).padStart(2, '0');
		return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`;
	}

	_set_label_text(labelEl, text) {
		if (!labelEl) return;
		const inner = labelEl.querySelector('div');
		if (inner) inner.textContent = text;
		else labelEl.textContent = text;
	}

	_get_frame_style(node, col, width = node.w) {
		const frame = this._get_frame_metrics(node, width);
		return {
			frame,
			style: {
				width: frame.width + 'px',
				height: frame.height + 'px',
				boxSizing: 'border-box',
				background: 'transparent',
				border: `${frame.strokeWidth}px dashed ${col}`,
				borderRadius: frame.rx + 'px',
				opacity: '0.95',
			}
		};
	}

	_get_label_text_nudge(node) {
		return node.depth === 0 ? '-1px' : '0px';
	}

	_make_selection_box(node, col) {
		const ns = 'http://www.w3.org/2000/svg';
		const { frame, style } = this._get_frame_style(node, col);
		const fo = document.createElementNS(ns, 'foreignObject');
		fo.setAttribute('x', String(frame.x));
		fo.setAttribute('y', String(frame.y));
		fo.setAttribute('width', String(frame.width));
		fo.setAttribute('height', String(frame.height));
		fo.style.overflow = 'visible';
		fo.style.pointerEvents = 'none';
		const div = document.createElement('div');
		Object.assign(div.style, style);
		fo.appendChild(div);
		return fo;
	}

	_get_frame_metrics(node, width = node.w) {
		if (node.depth === 0) {
			return {
				x: 0,
				y: 1,
				width,
				height: 34,
				rx: 18,
				strokeWidth: 1.5,
				paddingX: 8,
				framePad: 0,
				boxExtra: 0,
			};
		}
		return {
			x: -3,
			y: -9,
			width: width + 6,
			height: 27,
			rx: 6,
			strokeWidth: 1.8,
			paddingX: 3,
			framePad: 3,
			boxExtra: 6,
		};
	}

	_get_toggle_button_position(node) {
		if (!node || node.depth === 0 || !node.children?.length) return null;
		const mode = this.field_layout?.get_value() || 'Right';
		const goLeft = mode === 'Tree' && node._parent && node.x < node._parent.x;
		return {
			cx: goLeft ? node.x - 14 : node.x + node.w + 14,
			cy: node.y + 12,
			goLeft,
			r: 9,
		};
	}

	// ── Draw Edges ─────────────────────────────────────────────────────────────

	_draw_edges(g, node) {
		if (node.collapsed || !node.children.length) return;
		const ns = 'http://www.w3.org/2000/svg';
		const colors = this._colors();
		const mode = this.field_layout?.get_value() || 'Right';
		const isSingle = node.children.length === 1;

		node.children.forEach((child) => {
			const col2 = colors[Math.min(child.depth, colors.length - 1)];
			const edgeCol = col2;

			let goLeft = false;
			if (mode === 'Tree') {
				goLeft = child.x < node.x;
			}
			const btn = this._get_toggle_button_position(node);
			let x1 = goLeft ? node.x : node.x + node.w;
			if (btn && btn.goLeft === goLeft) {
				x1 = btn.cx + (goLeft ? -btn.r : btn.r);
			}
			const x2 = goLeft ? child.x + child.w : child.x;

			const path = document.createElementNS(ns, 'path');
			const y1 = node.depth === 0 ? node.y : node.y + 12;
			const y2 = child.y + 12;
			let d;
			const curve = Math.max(28, Math.min(58, Math.abs(x2 - x1) * 0.35));
			if (isSingle) {
				const mx = x1 + (x2 - x1) * 0.5;
				d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
			} else {
				d = `M${x1},${y1} C${x1 + (goLeft ? -curve : curve)},${y1} ${x2 + (goLeft ? curve : -curve)},${y2} ${x2},${y2}`;
			}
			path.setAttribute('d', d);
			path.setAttribute('fill', 'none');
			path.setAttribute('stroke', edgeCol);
			path.setAttribute('stroke-width', '2.5');
			path.setAttribute('opacity', '1');
			path.setAttribute('stroke-linecap', 'butt');
			path.setAttribute('stroke-linejoin', 'round');
			g.appendChild(path);
			this._draw_edges(g, child);
		});
	}

	// ── Draw Nodes ─────────────────────────────────────────────────────────────

	_draw_nodes(g, n) {
		const ns = 'http://www.w3.org/2000/svg';
		const colors = this._colors();
		const col = colors[Math.min(n.depth, colors.length - 1)];
		const grp = document.createElementNS(ns, 'g');
		grp.classList.add('mm-node');
		grp.dataset.id = n._id;
		grp.style.cursor = 'pointer';

		const isMultiSelected = this._selected_nodes.has(n._id);
		const mode = this.field_layout?.get_value() || 'Right';

		if (n.depth === 0) {
			grp.setAttribute('transform', `translate(${n.x},${n.y - 18})`);

			if (isMultiSelected) {
				const selBox = this._make_selection_box(n, col);
				n._el_sel_box = selBox;
				grp.appendChild(selBox);
			}

			const r = document.createElementNS(ns, 'rect');
			r.setAttribute('width', n.w); r.setAttribute('height', 36);
			r.setAttribute('rx', 18); r.setAttribute('fill', col);
			n._el_rect = r;
			grp.appendChild(r);

			const t = document.createElementNS(ns, 'text');
			t.classList.add('mm-label');
			t.textContent = n.label;
			t.setAttribute('x', n.w / 2); t.setAttribute('y', 18);
			t.setAttribute('text-anchor', 'middle');
			t.setAttribute('dominant-baseline', 'central');
			t.setAttribute('fill', '#fff');
			t.setAttribute('font-weight', 'bold');
			t.style.fontSize = '16px';
			t.style.fontFamily = this._get_font_family();
			t.style.pointerEvents = 'auto';
			grp.appendChild(t);
		} else {
			grp.setAttribute('transform', `translate(${n.x},${n.y - 10})`);
			const frame = this._get_frame_metrics(n);

			const hit = document.createElementNS(ns, 'rect');
			hit.setAttribute('width', n.w); hit.setAttribute('height', 30);
			hit.setAttribute('fill', 'transparent');
			n._el_rect = hit;
			grp.appendChild(hit);

			if (isMultiSelected) {
				const selBox = this._make_selection_box(n, col);
				n._el_sel_box = selBox;
				grp.appendChild(selBox);
			}

			const l = document.createElementNS(ns, 'line');
			l.setAttribute('x1', 0); l.setAttribute('y1', 22);
			l.setAttribute('x2', n.w); l.setAttribute('y2', 22);
			l.setAttribute('stroke', col); l.setAttribute('stroke-width', '2.5');
			l.setAttribute('stroke-linecap', 'square');
			l.setAttribute('opacity', '1');
			n._el_line = l;
			grp.appendChild(l);

			if (n.children.length > 0 && !n.collapsed) {
				const mode = this.field_layout?.get_value() || 'Right';
				const goLeft = mode === 'Tree' && n._parent && n.x < n._parent.x;
				const bridge = document.createElementNS(ns, 'line');
				const bridgeStart = goLeft ? 0.5 : n.w - 0.5;
				const bridgeEnd = goLeft ? -14 + 9 + 0.5 : n.w + 14 - 9 - 0.5;
				bridge.setAttribute('x1', bridgeStart);
				bridge.setAttribute('y1', 22);
				bridge.setAttribute('x2', bridgeEnd);
				bridge.setAttribute('y2', 22);
				bridge.setAttribute('stroke', col);
				bridge.setAttribute('stroke-width', '2.5');
				bridge.setAttribute('stroke-linecap', 'square');
				bridge.setAttribute('opacity', '1');
				grp.appendChild(bridge);
			}

			const fo = document.createElementNS(ns, 'foreignObject');
			fo.classList.add('mm-label');
			fo.setAttribute('x', frame.x);
			fo.setAttribute('y', frame.y);
			fo.setAttribute('width', frame.width);
			fo.setAttribute('height', frame.height);
			fo.style.overflow = 'visible';
			fo.style.pointerEvents = 'none';

			const t = document.createElement('div');
			t.textContent = n.label;
			Object.assign(t.style, {
				fontSize: '14px',
				fontWeight: '500',
				fontFamily: this._get_font_family(),
				color: 'var(--text-color)',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				textAlign: 'center',
				whiteSpace: 'nowrap',
				padding: `0 ${frame.paddingX}px`,
				boxSizing: 'border-box',
				lineHeight: '1',
				width: frame.width + 'px',
				height: frame.height + 'px',
				background: 'transparent',
				position: 'relative',
				top: this._get_label_text_nudge(n),
			});
			fo.appendChild(t);
			grp.appendChild(fo);
		}

		// ── Collapse/Expand button ──────────────────────────────────────────
		if (n.depth > 0 && n.children.length > 0) {
			const btn = document.createElementNS(ns, 'g');
			btn.classList.add('mm-btn');

			// Determine which side children are on
			let bx;
			if (mode === 'Tree' && n.depth > 0) {
				const goLeft = !!(n._parent && n.x < n._parent.x);
				bx = goLeft ? -14 : n.w + 14;
			} else {
				bx = n.w + 14; // root always right; Right layout always right
			}
			const by = n.depth === 0 ? 18 : 22;

			btn.innerHTML = `
				<circle cx="${bx}" cy="${by}" r="9" fill="var(--card-bg)" stroke="${col}" stroke-width="2" opacity="0.95"/>
				<text x="${bx}" y="${by}" text-anchor="middle" dominant-baseline="central" font-size="13" fill="${col}" font-weight="bold">${n.collapsed ? '+' : '−'}</text>
			`;

			btn.onclick = (e) => {
				e.stopPropagation();
				n.collapsed = !n.collapsed;
				this._push_history();
				this.tree = this._build(this._serialize(this.tree), null);
				this._re_render();
				this._mark_dirty();
				this._scroll_to(n);
			};
			grp.appendChild(btn);
		}

		// ── Click / double-click ────────────────────────────────────────────
		let clickTimer = null;

		grp.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this._drag_click_suppressed) {
				this._drag_click_suppressed = false;
				return;
			}
			if (clickTimer) return;
			clickTimer = setTimeout(() => {
				clickTimer = null;
				if (e.shiftKey || e.ctrlKey || e.metaKey) {
					this._toggle_multi_select(n);
				} else {
					this._clear_multi_select();
					this._select(n);
				}
			}, 200);
		});

		grp.addEventListener('dblclick', (e) => {
			e.stopPropagation();
			if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
			this._start_rename(n);
		});

		grp.oncontextmenu = (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._show_ctx(n, e.clientX, e.clientY);
		};

		// ── Drag-and-drop reorder (same parent siblings only) ───────────────
		this._setup_dnd(grp, n);

		g.appendChild(grp);
		if (!n.collapsed) n.children.forEach(c => this._draw_nodes(g, c));
	}

	// ── Drag & Drop reorder ────────────────────────────────────────────────────

	_setup_dnd(grp, n) {
		grp.addEventListener('mousedown', (e) => {
			if (e.button !== 0 || this._is_editing()) return;
			if (e.target.closest('.mm-btn')) return;
			e.stopPropagation();
			e.preventDefault();
			this._hide_ctx();
			this._drag_pointer = {
				node: n,
				startX: e.clientX,
				startY: e.clientY,
				group: grp
			};
			this._drag_active = false;
			this._drag_preview = null;
			this._drag_hover_node = null;
		});
	}

	_show_drop_indicator(n, mode = 'after') {
		const ind = document.getElementById('mm-drop-indicator');
		const cv = document.getElementById('mm-canvas');
		const cvRect = cv.getBoundingClientRect();
		const grp = document.querySelector(`.mm-node[data-id="${n._id}"]`);
		if (!grp) return;
		const bbox = grp.getBoundingClientRect();
		ind.style.display = 'block';
		ind.style.left = (bbox.left - cvRect.left) + 'px';
		ind.style.top = ((mode === 'before' ? bbox.top : bbox.bottom) - cvRect.top - 2) + 'px';
		ind.style.width = (bbox.width) + 'px';
	}

	_hide_drop_indicator() {
		const ind = document.getElementById('mm-drop-indicator');
		if (ind) ind.style.display = 'none';
	}

	_begin_node_drag() {
		if (!this._drag_pointer || this._drag_active) return;
		this._drag_active = true;
		this._dnd_node = this._drag_pointer.node;
		this._drag_pointer.group.style.opacity = '0.45';
		this._drag_pointer.group.style.pointerEvents = 'none';
		document.getElementById('mm-canvas').style.cursor = 'grabbing';
	}

	_update_node_drag(e) {
		if (!this._drag_pointer) return;
		const dx = e.clientX - this._drag_pointer.startX;
		const dy = e.clientY - this._drag_pointer.startY;
		if (!this._drag_active) {
			if (Math.hypot(dx, dy) < 8) return;
			this._begin_node_drag();
		}
		this._drag_click_suppressed = true;
		this._clear_drop_target_highlight();
		this._drag_preview = this._get_drop_preview(e.clientX, e.clientY);
		if (!this._drag_preview) {
			this._hide_drop_indicator();
			return;
		}
		if (this._drag_preview.mode === 'parent') {
			this._hide_drop_indicator();
			this._highlight_drop_target(this._drag_preview.target);
		} else {
			this._show_drop_indicator(this._drag_preview.target, this._drag_preview.mode);
		}
	}

	_finish_node_drag() {
		if (this._drag_pointer?.group) {
			this._drag_pointer.group.style.opacity = '1';
			this._drag_pointer.group.style.pointerEvents = '';
		}
		document.getElementById('mm-canvas').style.cursor = this._pan_mode ? 'grab' : 'default';
		if (this._drag_active && this._drag_preview) {
			const { mode, target } = this._drag_preview;
			if (mode === 'parent') this._move_node_to_parent(this._dnd_node, target);
			if (mode === 'before' || mode === 'after') this._move_node_relative(this._dnd_node, target, mode);
		}
		this._drag_pointer = null;
		this._drag_active = false;
		this._drag_preview = null;
		this._dnd_node = null;
		this._dnd_over = null;
		this._hide_drop_indicator();
		this._clear_drop_target_highlight();
		setTimeout(() => { this._drag_click_suppressed = false; }, 0);
	}

	_get_drop_preview(clientX, clientY) {
		if (!this._dnd_node) return null;
		const el = document.elementFromPoint(clientX, clientY);
		const grp = el ? el.closest('.mm-node') : null;
		if (!grp) return null;
		const target = this._find_by_id(this.tree, grp.dataset.id);
		if (!target || target === this._dnd_node) return null;
		if (this._is_descendant(target, this._dnd_node)) return null;
		const box = grp.getBoundingClientRect();
		const relY = box.height ? (clientY - box.top) / box.height : 0.5;
		if (this._dnd_node._parent && target._parent === this._dnd_node._parent) {
			if (relY <= 0.42) return { mode: 'before', target };
			if (relY >= 0.58) return { mode: 'after', target };
		}
		if (this._can_reparent(this._dnd_node, target)) {
			return { mode: 'parent', target };
		}
		return null;
	}

	_can_reparent(node, target) {
		if (!node || !target) return false;
		if (!node._parent) return false;
		if (node === target) return false;
		if (this._is_descendant(target, node)) return false;
		return true;
	}

	_is_descendant(node, possibleAncestor) {
		let cur = node;
		while (cur) {
			if (cur === possibleAncestor) return true;
			cur = cur._parent;
		}
		return false;
	}

	_move_node_relative(node, target, mode) {
		if (!node || !target || !node._parent || node._parent !== target._parent) return;
		const parent = node._parent;
		const fromIdx = parent.children.indexOf(node);
		const targetIdx = parent.children.indexOf(target);
		if (fromIdx === -1 || targetIdx === -1) return;
		this._push_history();
		parent.children.splice(fromIdx, 1);
		let insertIdx = parent.children.indexOf(target);
		if (mode === 'after') insertIdx += 1;
		parent.children.splice(insertIdx, 0, node);
		if (!parent._parent && (this.field_layout?.get_value() || 'Right') === 'Tree') {
			node.tree_side = target.tree_side || node.tree_side || 'right';
		}
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
		this._mark_dirty();
	}

	_move_node_to_parent(node, newParent) {
		if (!node || !newParent || !this._can_reparent(node, newParent)) return;
		this._push_history();
		node._parent.children = node._parent.children.filter(c => c !== node);
		node._parent = newParent;
		newParent.children.push(node);
		if (!newParent._parent && (this.field_layout?.get_value() || 'Right') === 'Tree') {
			node.tree_side = newParent.children.length % 2 === 0 ? 'left' : 'right';
		}
		newParent.collapsed = false;
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
		this._mark_dirty();
	}

	_highlight_drop_target(node) {
		this._drag_hover_node = node;
		if (!node) return;
		if (node === this.selected) return;
		if (this._selected_nodes.has(node._id)) return;
		this._highlight(node, true);
	}

	_clear_drop_target_highlight() {
		if (!this._drag_hover_node) return;
		const node = this._drag_hover_node;
		this._drag_hover_node = null;
		if (node === this.selected) return;
		if (this._selected_nodes.has(node._id)) return;
		this._highlight(node, false);
	}

	// ── Selection ──────────────────────────────────────────────────────────────

	_select(node) {
		this._deselect();
		this.selected = node;
		this._highlight(node, true);
		document.getElementById('mm-canvas').focus();
	}

	_deselect() {
		if (this.selected) this._highlight(this.selected, false);
		this.selected = null;
	}

	_highlight(node, on) {
		if (!node._el_rect) return;
		const col = this._colors()[Math.min(node.depth, this._colors().length - 1)];
		if (on) {
			if (!node._el_sel_box) {
				const grp = node._el_rect.parentNode;
				const selBox = this._make_selection_box(node, col);
				node._el_sel_box = selBox;
				grp.appendChild(selBox);
			}
		} else if (node._el_sel_box && node._el_sel_box.parentNode) {
			node._el_sel_box.parentNode.removeChild(node._el_sel_box);
			node._el_sel_box = null;
		}
	}

	_toggle_multi_select(node) {
		if (this._selected_nodes.has(node._id)) {
			this._selected_nodes.delete(node._id);
			this._highlight_multi(node, false);
		} else {
			this._selected_nodes.add(node._id);
			this._highlight_multi(node, true);
		}
	}

	_highlight_multi(node, on) {
		const col = this._colors()[Math.min(node.depth, this._colors().length - 1)];
		if (on && !node._el_sel_box) {
			const grp = node._el_rect ? node._el_rect.parentNode : null;
			if (grp) {
				const selBox = this._make_selection_box(node, col);
				node._el_sel_box = selBox;
				grp.appendChild(selBox);
			}
		} else if (!on && node._el_sel_box && node._el_sel_box.parentNode) {
			node._el_sel_box.parentNode.removeChild(node._el_sel_box);
			node._el_sel_box = null;
		}
	}

	_make_child_selection_box(node, col) {
		return this._make_selection_box(node, col);
	}

	_clear_multi_select() {
		this._selected_nodes.forEach(id => {
			const n = this._find_by_id(this.tree, id);
			if (n) this._highlight_multi(n, false);
		});
		this._selected_nodes.clear();
	}

	_finalize_lasso() {
		if (!this.tree) return;
		const lr = this._lasso_rect;
		if (lr.w < 5 && lr.h < 5) return;
		const x0 = lr.x, y0 = lr.y, x1 = lr.x + lr.w, y1 = lr.y + lr.h;
		const check = (n) => {
			const nx = n.x, ny = n.depth === 0 ? n.y - 18 : n.y - 10;
			const nw = n.w, nh = n.depth === 0 ? 36 : 30;
			if (nx < x1 && nx + nw > x0 && ny < y1 && ny + nh > y0) {
				if (!this._selected_nodes.has(n._id)) {
					this._selected_nodes.add(n._id);
					this._highlight_multi(n, true);
				}
			}
			if (!n.collapsed) n.children.forEach(c => check(c));
		};
		check(this.tree);
		if (this._selected_nodes.size === 1) {
			const id = [...this._selected_nodes][0];
			const n = this._find_by_id(this.tree, id);
			if (n) this._select(n);
		}
	}

	_delete_selected_nodes() {
		let changed = false;
		this._selected_nodes.forEach(id => {
			const n = this._find_by_id(this.tree, id);
			if (n && n._parent) {
				n._parent.children = n._parent.children.filter(c => c !== n);
				changed = true;
			}
		});
		this._selected_nodes.clear();
		this.selected = null;
		if (changed) {
			this._push_history();
			this.tree = this._build(this._serialize(this.tree), null);
			this._re_render();
			this._mark_dirty();
		}
	}

	// ── Context Menu ───────────────────────────────────────────────────────────

	_show_ctx(node, x, y) {
		this._select(node);
		const ctx = document.getElementById('mm-ctx');
		const items = [
			{ icon: '＋', key: 'child', label: 'Child' },
			{ icon: '↳', key: 'sib', label: 'Sibling' },
			{ icon: '↑', key: 'parent', label: 'Parent' },
			{ icon: '✎', key: 'edit', label: 'Edit' },
			{ icon: '✕', key: 'del', label: 'Delete', danger: true }
		];
		ctx.innerHTML =
			`<div style="padding:4px 0;min-width:160px;background:var(--card-bg,#1f1f1f);color:var(--text-color,#f5f5f5)">` +
			items.map(it => `
				<div data-key="${it.key}" title="${it.label}"
					style="display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;color:${it.danger ? 'var(--red-500,#ff5c5c)' : 'var(--text-color,#f5f5f5)'};font-weight:500">
					<span style="width:16px;text-align:center">${it.icon}</span>
					<span>${it.label}</span>
				</div>
			`).join('') +
			`</div>`;
		ctx.style.display = 'block';
		ctx.style.left = x + 'px';
		ctx.style.top = y + 'px';
		ctx.querySelectorAll('[data-key]').forEach(el => {
			el.onmouseenter = () => { el.style.background = 'rgba(127,127,127,0.18)'; };
			el.onmouseleave = () => { el.style.background = 'transparent'; };
			el.onclick = () => {
				this._hide_ctx();
				const k = el.dataset.key;
				if (k === 'child') this._add_child(node);
				else if (k === 'sib') this._add_sibling(node);
				else if (k === 'parent') this._add_parent(node);
				else if (k === 'edit') this._start_rename(node);
				else if (k === 'del') this._delete_node(node);
			};
		});
	}

	_hide_ctx() {
		document.getElementById('mm-ctx').style.display = 'none';
	}

	// ── Rename ─────────────────────────────────────────────────────────────────

	_start_rename(node, opts = {}) {
		if (!node || !node._el_rect) return;

		const ns = 'http://www.w3.org/2000/svg';
		const grp = node._el_rect.parentNode;
		const col = this._colors()[Math.min(node.depth, this._colors().length - 1)];
		const mode = this.field_layout?.get_value() || 'Right';
		const isLeftTreeNode = mode === 'Tree' && node.depth > 0 && node._parent && node.x < node._parent.x;
		const wasSelected = !!(this.selected && this.selected._id === node._id);
		const wasMultiSelected = this._selected_nodes.has(node._id);
		let createdEditFrame = false;
		if (!node._el_sel_box) {
			node._el_sel_box = this._make_selection_box(node, col);
			grp.appendChild(node._el_sel_box);
			createdEditFrame = true;
		}

		// Hide existing SVG text
		const oldText = grp.querySelector('.mm-label');
		if (oldText) oldText.style.display = 'none';

		// Keep SVG underline visible during editing (don't hide it)
		// It will dynamically resize as user types

		const _savedLabel = node.label;
		// For new nodes: start empty; for rename: pre-fill existing text
		const initText = opts.is_new ? '' : _savedLabel;
		const frame = this._get_frame_metrics(node);
		const frameStyle = this._get_frame_style(node, col);
		const framePad = frame.framePad;
		const boxExtra = frame.boxExtra;

		const calcW = (text) => this._get_node_width(text, node.depth);
		let foW = calcW(initText);
		let frameW = foW + boxExtra;

		const fo = document.createElementNS(ns, 'foreignObject');
		fo.setAttribute('x', node.depth === 0 ? 0 : (isLeftTreeNode ? (node.w - foW - framePad) : -framePad));
		fo.setAttribute('y', frame.y);
		fo.setAttribute('width', frameW);
		fo.setAttribute('height', frame.height);
		fo.style.overflow = 'visible';

		const div = document.createElement('div');
		div.contentEditable = true;
		div.spellcheck = false;
		div.innerText = initText;
		Object.assign(div.style, {
			outline: 'none',
			fontSize: node.depth === 0 ? '16px' : '14px',
			fontWeight: node.depth === 0 ? 'bold' : '500',
			fontFamily: this._get_font_family(),
			color: node.depth === 0 ? '#fff' : 'var(--text-color)',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			textAlign: 'center',
			whiteSpace: 'nowrap',
			padding: `0 ${frame.paddingX}px`,
			boxSizing: 'border-box',
			lineHeight: '1',
			width: frameW + 'px',
			minWidth: '80px',
			height: frame.height + 'px',
			background: 'transparent',
			border: 'none',
			borderRadius: frameStyle.style.borderRadius,
			cursor: 'text',
			position: 'relative',
			top: this._get_label_text_nudge(node),
		});
		div.addEventListener('mousedown', (e) => e.stopPropagation());
		div.addEventListener('click', (e) => e.stopPropagation());
		div.addEventListener('dblclick', (e) => e.stopPropagation());

		fo.appendChild(div);
		grp.appendChild(fo);

		// Put caret at end to avoid the selected-text flash on rename
		div.focus();
		const range = document.createRange();
		range.selectNodeContents(div);
		range.collapse(false);
		const sel = window.getSelection();
		sel.removeAllRanges();
		sel.addRange(range);

		const update = () => {
			const text = div.innerText || '';
			const w = calcW(text);
			const prevW = node.w;
			const nextFrameW = w + boxExtra;
			if (prevW !== w) {
				this._live_edit_relayout(node, prevW, w, isLeftTreeNode, fo, framePad);
			}
			if (isLeftTreeNode) {
				fo.setAttribute('x', node.w - w - framePad);
			}
			fo.setAttribute('width', nextFrameW);
			div.style.width = nextFrameW + 'px';
			// Sync SVG underline width using the updated node width/position
			if (node._el_line) {
				if (isLeftTreeNode) {
					node._el_line.setAttribute('x1', node.w - w);
					node._el_line.setAttribute('x2', node.w);
				} else {
					node._el_line.setAttribute('x1', 0);
					node._el_line.setAttribute('x2', w);
				}
			}
		};

		const restoreEditState = () => {
			if (createdEditFrame && !wasSelected && !wasMultiSelected && node._el_sel_box && node._el_sel_box.parentNode) {
				node._el_sel_box.parentNode.removeChild(node._el_sel_box);
				node._el_sel_box = null;
			}
		};

		let save = () => {
			const val = (div.innerText || '').trim();
			fo.remove();
			if (oldText) oldText.style.display = '';
			// Restore underline to final width
			if (node._el_line) {
				node._el_line.setAttribute('x1', 0);
				node._el_line.setAttribute('x2', node.w);
			}

			if (!val) {
				if (opts.is_new && opts.on_cancel) {
					opts.on_cancel();
				} else {
					node.label = _savedLabel;
					node.w = calcW(_savedLabel);
					this._set_label_text(oldText, _savedLabel);
					if (node._el_line) {
						node._el_line.setAttribute('x1', 0);
						node._el_line.setAttribute('x2', node.w);
					}
					restoreEditState();
				}
				return;
			}

			node.label = val;
			node.w = calcW(val);
			this._set_label_text(oldText, val);

			this._push_history();
			this.tree = this._build(this._serialize(this.tree), null);
			this._re_render();
			this._mark_dirty();
		};

		let _saved = false;
		const saveOnce = () => { if (!_saved) { _saved = true; save(); } };
		const onDocMouseDown = (e) => {
			if (!div.isConnected) return;
			if (div.contains(e.target)) return;
			saveOnce();
		};
		const hasSelectionInside = () => {
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0) return false;
			const anchorNode = sel.anchorNode;
			const focusNode = sel.focusNode;
			return (anchorNode && div.contains(anchorNode)) || (focusNode && div.contains(focusNode));
		};
		document.addEventListener('mousedown', onDocMouseDown, true);

		div.addEventListener('input', update);
		update(); // initial sync

		div.addEventListener('blur', () => {
			setTimeout(() => {
				if (!div.isConnected) return;
				if (hasSelectionInside()) {
					div.focus();
					return;
				}
				if (document.activeElement !== div) saveOnce();
			}, 120);
		});

		div.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); saveOnce(); }
			if (e.key === 'Escape') {
				_saved = true;
				document.removeEventListener('mousedown', onDocMouseDown, true);
				fo.remove();
				if (oldText) {
					oldText.style.display = '';
					this._set_label_text(oldText, _savedLabel);
				}
				if (node._el_line) {
					node._el_line.setAttribute('x1', 0);
					node._el_line.setAttribute('x2', node.w);
				}
				node.label = _savedLabel;
				restoreEditState();
				if (opts.is_new && opts.on_cancel) opts.on_cancel();
			}
			e.stopPropagation();
		});

		const originalSave = save;
		save = () => {
			document.removeEventListener('mousedown', onDocMouseDown, true);
			originalSave();
		};
	}

	// ── Node Mutations ─────────────────────────────────────────────────────────

	_add_child(node) {
		const newId = Math.random().toString(36).slice(2, 9);
		const c = {
			label: '', // empty label — user types fresh
			children: [],
			_parent: node,
			_id: newId
		};
		if (!node.children) node.children = [];
		node.children.push(c);
		node.collapsed = false;
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
		this._scroll_to(c);

		setTimeout(() => {
			const newNode = this._find_by_id(this.tree, newId);
			if (!newNode) return;
			this._select(newNode);
			this._start_rename(newNode, {
				is_new: true,
				on_cancel: () => {
					// Remove node if user typed nothing
					if (newNode._parent) {
						newNode._parent.children = newNode._parent.children.filter(x => x._id !== newId);
					}
					this.tree = this._build(this._serialize(this.tree), null);
					this._re_render();
				}
			});
		}, 100);
	}

	_add_sibling(node) {
		if (!node._parent) return;
		const newId = Math.random().toString(36).slice(2, 9);
		const s = {
			label: '',
			children: [],
			_parent: node._parent,
			_id: newId,
			tree_side: node.tree_side || null
		};
		node._parent.children.splice(node._parent.children.indexOf(node) + 1, 0, s);
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
		this._scroll_to(s);
		setTimeout(() => {
			const newNode = this._find_by_id(this.tree, newId);
			if (!newNode) return;
			this._select(newNode);
			this._start_rename(newNode, {
				is_new: true,
				on_cancel: () => {
					if (newNode._parent) {
						newNode._parent.children = newNode._parent.children.filter(x => x._id !== newId);
					}
					this.tree = this._build(this._serialize(this.tree), null);
					this._re_render();
				}
			});
		}, 100);
	}

	_add_parent(node) {
		if (!node._parent) return;
		const oldP = node._parent;
		const idx = oldP.children.indexOf(node);
		const newP = {
			label: 'New Parent', children: [node],
			_parent: oldP,
			_id: Math.random().toString(36).slice(2, 9)
		};
		node._parent = newP;
		oldP.children.splice(idx, 1, newP);
		this._push_history();
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
		this._scroll_to(newP);
		setTimeout(() => this._start_rename(this._find_by_id(this.tree, newP._id)), 100);
	}

	_delete_node(node) {
		if (!node._parent) return;
		node._parent.children = node._parent.children.filter(c => c !== node);
		this.selected = null;
		this._push_history();
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
		this._mark_dirty();
	}

	// ── Scroll / Fit ───────────────────────────────────────────────────────────

	_scroll_to(node) {
		setTimeout(() => {
			const f = this._find_by_id(this.tree, node._id);
			if (!f) return;
			const cv = document.getElementById('mm-canvas');
			const tx = cv.clientWidth / 2 - f.x * this.vscale;
			const ty = cv.clientHeight / 2 - f.y * this.vscale;
			const sx = this.vx, sy = this.vy;
			const dur = 400, start = Date.now();
			const anim = () => {
				const p = Math.min((Date.now() - start) / dur, 1);
				this.vx = sx + (tx - sx) * p;
				this.vy = sy + (ty - sy) * p;
				this._apply_transform();
				if (p < 1) requestAnimationFrame(anim);
			};
			anim();
		}, 50);
	}

	_fit_view(root) {
		const g = document.getElementById('mm-g');
		const bbox = g.getBBox();
		const cv = document.getElementById('mm-canvas');
		if (bbox.width === 0) return;
		this.vscale = Math.min(1.8, Math.min((cv.clientWidth - 60) / bbox.width, (cv.clientHeight - 60) / bbox.height));
		this.vx = cv.clientWidth / 2 - (bbox.x + bbox.width / 2) * this.vscale;
		this.vy = cv.clientHeight / 2 - (bbox.y + bbox.height / 2) * this.vscale;
		this._apply_transform();
	}

	// ── Save / Serialize ───────────────────────────────────────────────────────

	_save() {
		if (!this.doc) return;
		this._set_save_status('Saving...');
		frappe.call({
			method: 'frappe.client.set_value',
			args: {
				doctype: 'Mind Map',
				name: this.doc.name,
				fieldname: { map_json: this._stringify_map(this.tree) }
			},
			callback: () => this._set_save_status('✓ Saved')
		});
	}

	_serialize(n) {
		const out = {
			_id: n._id,
			label: n.label
		};
		if (n.note) out.note = n.note;
		if (n.collapsed) out.collapsed = true;
		if (n.tree_side) out.tree_side = n.tree_side;
		const kids = (n.children || []).map(c => this._serialize(c));
		if (kids.length) out.child = kids;
		if (!n._parent) {
			out.layout = this.field_layout?.get_value() || 'Right';
		}
		return out;
	}

	_stringify_map(root) {
		return JSON.stringify(this._serialize(root), null, 2);
	}

	_set_save_status(t) {
		const s = document.getElementById('mm-save-status');
		if (s) s.textContent = t;
	}

	_mark_dirty() {
		this._set_save_status('● Unsaved');
		clearTimeout(this._autosave_timer);
		this._autosave_timer = setTimeout(() => this._save(), 5000);
	}

	_find_by_id(n, id) {
		if (n._id === id) return n;
		for (const c of n.children) {
			const r = this._find_by_id(c, id);
			if (r) return r;
		}
		return null;
	}

	_get_node_group(node) {
		return node?._el_rect?.parentNode || null;
	}

	_update_node_group_transform(node) {
		const grp = this._get_node_group(node);
		if (!grp) return;
		grp.setAttribute('transform', `translate(${node.x},${node.depth === 0 ? node.y - 18 : node.y - 10})`);
	}

	_update_node_controls(node) {
		const grp = this._get_node_group(node);
		if (!grp || !node.children.length || node.depth === 0) return;
		const btn = grp.querySelector('.mm-btn');
		if (!btn) return;
		const mode = this.field_layout?.get_value() || 'Right';
		const col = this._colors()[Math.min(node.depth, this._colors().length - 1)];
		const goLeft = mode === 'Tree' && node._parent && node.x < node._parent.x;
		const bx = goLeft ? -14 : node.w + 14;
		const by = 22;
		btn.innerHTML = `
			<circle cx="${bx}" cy="${by}" r="9" fill="var(--card-bg)" stroke="${col}" stroke-width="2" opacity="0.95"/>
			<text x="${bx}" y="${by}" text-anchor="middle" dominant-baseline="central" font-size="13" fill="${col}" font-weight="bold">${node.collapsed ? '+' : '−'}</text>
		`;
	}

	_shift_subtree_x(node, dx) {
		if (!node || !node.children?.length) return;
		node.children.forEach(child => {
			child.x += dx;
			this._update_node_group_transform(child);
			this._update_node_controls(child);
			this._shift_subtree_x(child, dx);
		});
	}

	_redraw_edges_only() {
		if (!this.tree) return;
		const g = document.getElementById('mm-g');
		const defs = document.getElementById('mm-defs');
		if (!g || !defs) return;
		defs.innerHTML = '';
		[...g.querySelectorAll('path')].forEach(p => p.remove());
		const temp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this._draw_edges(temp, this.tree);
		const firstNode = g.querySelector('.mm-node');
		[...temp.childNodes].forEach(child => {
			if (firstNode) g.insertBefore(child, firstNode);
			else g.appendChild(child);
		});
	}

	_live_edit_relayout(node, prevW, nextW, isLeftTreeNode, fo, framePad) {
		const delta = nextW - prevW;
		if (!delta) return;
		node.w = nextW;
		if (isLeftTreeNode) node.x -= delta;
		this._update_node_group_transform(node);
		this._update_node_controls(node);
		const descendantShift = isLeftTreeNode ? -delta : delta;
		this._shift_subtree_x(node, descendantShift);
		this._redraw_edges_only();
		if (fo && node.depth > 0) {
			fo.setAttribute('x', isLeftTreeNode ? (node.w - nextW - framePad) : -framePad);
		}
		if (node._el_sel_box) {
			const col = this._colors()[Math.min(node.depth, this._colors().length - 1)];
			const grp = node._el_rect ? node._el_rect.parentNode : null;
			if (grp && node._el_sel_box.parentNode) {
				node._el_sel_box.parentNode.removeChild(node._el_sel_box);
				node._el_sel_box = this._make_selection_box(node, col);
				grp.appendChild(node._el_sel_box);
			}
		}
	}

	// ── Theme / Misc ───────────────────────────────────────────────────────────

	_apply_theme() {
		this.tree = this._build(this._serialize(this.tree), null);
		this._re_render();
	}

	_remember_layout() {
		if (!this.doc?.name) return;
		localStorage.setItem(`mm_layout_${this.doc.name}`, this.field_layout?.get_value() || 'Right');
	}

	_get_saved_layout() {
		if (!this.doc?.name) return null;
		return localStorage.getItem(`mm_layout_${this.doc.name}`);
	}

	_restore_last_map() {
		const l = localStorage.getItem('mm_last_map');
		if (l) { this.field_doc.set_value(l); this._load(l); }
	}

	// ── Export ─────────────────────────────────────────────────────────────────

	_export_svg() {
		if (!this.doc) return;
		const g = document.getElementById('mm-g');
		const defs = document.getElementById('mm-defs');

		// Clone and remove UI-only elements
		const cloneG = g.cloneNode(true);
		const cloneDefs = defs.cloneNode(true);
		cloneG.querySelectorAll('.mm-btn').forEach(b => b.remove());

		// Use getBBox BEFORE cloning to get accurate bounds
		const bbox = g.getBBox();

		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('xmlns', ns);

		const pad = 60;
		const W = bbox.width + pad * 2;
		const H = bbox.height + pad * 2;

		svg.setAttribute('width', W);
		svg.setAttribute('height', H);
		svg.setAttribute('viewBox', `${bbox.x - pad} ${bbox.y - pad} ${W} ${H}`);

		// White background
		const bg = document.createElementNS(ns, 'rect');
		bg.setAttribute('x', bbox.x - pad); bg.setAttribute('y', bbox.y - pad);
		bg.setAttribute('width', W); bg.setAttribute('height', H);
		bg.setAttribute('fill', 'white');

		// Inline text color for dark-theme compatibility
		cloneG.querySelectorAll('text').forEach(t => {
			const fill = t.getAttribute('fill');
			if (fill === 'var(--text-color)' || !fill || fill === '') {
				t.setAttribute('fill', '#1a1a1a');
			}
		});

		// Remove transform from cloneG — we use viewBox instead
		cloneG.setAttribute('transform', '');

		svg.appendChild(cloneDefs);
		svg.appendChild(bg);
		svg.appendChild(cloneG);

		const svgStr = new XMLSerializer().serializeToString(svg);
		const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `${this.doc.title || 'MindMap'}.svg`;
		a.click();
	}

	_export_png() {
		if (!this.doc) return;
		const g = document.getElementById('mm-g');
		const defs = document.getElementById('mm-defs');
		const bbox = g.getBBox();

		const pad = 80;
		const W = bbox.width + pad * 2;
		const H = bbox.height + pad * 2;

		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		const dpr = 2;
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		ctx.scale(dpr, dpr);

		const cloneG = g.cloneNode(true);
		cloneG.querySelectorAll('.mm-btn').forEach(b => b.remove());
		cloneG.setAttribute('transform', '');

		// Fix var() references in clone
		cloneG.querySelectorAll('text').forEach(t => {
			const fill = t.getAttribute('fill');
			if (fill === 'var(--text-color)' || !fill || fill === '') {
				t.setAttribute('fill', '#1a1a1a');
			}
		});

		const svgData = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${bbox.x - pad} ${bbox.y - pad} ${W} ${H}">
			<rect x="${bbox.x - pad}" y="${bbox.y - pad}" width="${W}" height="${H}" fill="white"/>
			<defs>${defs.innerHTML}</defs>
			${cloneG.outerHTML}
		</svg>`;

		const img = new Image();
		img.onload = () => {
			ctx.drawImage(img, 0, 0);
			canvas.toBlob(b => {
				const a = document.createElement('a');
				a.href = URL.createObjectURL(b);
				a.download = `${this.doc.title || 'MindMap'}.png`;
				a.click();
			}, 'image/png');
		};
		img.onerror = () => {
			// Fallback: try with encodeURIComponent
			const encoded = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
			img.src = encoded;
		};
		img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
	}

	// ── New / Open Dialogs ─────────────────────────────────────────────────────

	_new_doc() {
		const d = new frappe.ui.Dialog({
			title: __('New Mind Map'),
			fields: [{ fieldtype: 'Data', fieldname: 'title', label: __('Title'), reqd: 1 }],
			primary_action: v => {
				frappe.call({
					method: 'frappe.client.insert',
					args: { doc: { doctype: 'Mind Map', title: v.title, map_json: JSON.stringify({ label: v.title }, null, 2) } },
					callback: r => {
						d.hide();
						this.field_doc.set_value(r.message.name);
						this._load(r.message.name);
					}
				});
			}
		});
		d.show();
	}

	_open_doc() {
		const d = new frappe.ui.Dialog({
			title: __('Open Mind Map'),
			fields: [{ fieldtype: 'Link', fieldname: 'name', label: __('Mind Map'), options: 'Mind Map', reqd: 1 }],
			primary_action: v => {
				d.hide();
				this.field_doc.set_value(v.name);
				this._load(v.name);
			}
		});
		d.show();
	}
}
