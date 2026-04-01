# mind_map_viewer.py
# Place in: <app>/www/mind_map_viewer.py  OR  <app>/page/mind_map_viewer/mind_map_viewer.py
# Frappe auto-loads this when the page is opened.

import frappe


def get_context(context):
	"""Inject basic context. Frappe calls this automatically for page controllers."""
	context.no_cache = 1


@frappe.whitelist()
def get_mind_maps():
	"""
	Returns list of all Mind Maps the current user can read.
	Call from JS: frappe.call({ method: 'your_app.page.mind_map_viewer.mind_map_viewer.get_mind_maps' })
	"""
	maps = frappe.get_list(
		"Mind Map",
		fields=["name", "title", "modified"],
		order_by="modified desc",
		ignore_permissions=False,   # respects DocType permissions
	)
	return maps


@frappe.whitelist()
def duplicate_mind_map(name):
	"""
	Duplicate an existing Mind Map doc.
	Call from JS: frappe.call({ method: '...duplicate_mind_map', args: { name } })
	"""
	src = frappe.get_doc("Mind Map", name)
	new_doc = frappe.copy_doc(src)
	new_doc.title = src.title + " (Copy)"
	new_doc.insert(ignore_permissions=False)
	frappe.db.commit()
	return new_doc.name


@frappe.whitelist()
def delete_mind_map(name):
	"""
	Delete a Mind Map doc after permission check.
	"""
	frappe.delete_doc("Mind Map", name, ignore_permissions=False)
	frappe.db.commit()
	return {"deleted": name}