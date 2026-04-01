// mind_map_viewer.js
// Place in: <app>/public/js/mind_map_viewer.js
// Also add to page JSON scripts array alongside mind_map_core.js

frappe.pages['mind-map-viewer'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Mind Map',
		single_column: true,
	});
	new MindMapPage(page, wrapper);
};