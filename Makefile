UUID := quick-last-bluetooth@tech.puffyslippers.com
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: schemas install pack clean

schemas:
	glib-compile-schemas schemas

install: schemas
	mkdir -p "$(DEST)"
	cp -r extension.js metadata.json schemas "$(DEST)/"

pack: schemas
	gnome-extensions pack --force --out-dir=. \
		--schema=schemas/org.gnome.shell.extensions.quick-last-bluetooth.gschema.xml .
	zip -q "$(UUID).shell-extension.zip" schemas/gschemas.compiled

clean:
	rm -f schemas/gschemas.compiled "$(UUID).shell-extension.zip"
