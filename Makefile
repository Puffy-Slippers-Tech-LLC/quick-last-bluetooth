UUID := quick-last-bluetooth@tech.puffyslippers.com
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: schemas install uninstall pack clean

schemas:
	glib-compile-schemas schemas

install: schemas
	mkdir -p "$(DEST)"
	cp -r extension.js metadata.json schemas "$(DEST)/"

uninstall:
	rm -rf "$(DEST)"
	dconf reset -f /org/gnome/shell/extensions/quick-last-bluetooth/

pack: schemas
	gnome-extensions pack --force --out-dir=. \
		--schema=schemas/org.gnome.shell.extensions.quick-last-bluetooth.gschema.xml .

clean:
	rm -f schemas/gschemas.compiled "$(UUID).shell-extension.zip"
