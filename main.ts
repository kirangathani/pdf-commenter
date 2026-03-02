import { Plugin, PluginManifest, FuzzySuggestModal, TFile } from "obsidian";
import { VIEW_TYPE_PDF_COMMENTER, PdfCommenterView } from './view';

class PdfFileSuggestModal extends FuzzySuggestModal<TFile> {
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter(f => f.extension === 'pdf');
	}
	getItemText(item: TFile): string {
		return item.path;
	}
	onChooseItem(item: TFile): void {
		this.app.workspace.getLeaf(false).openFile(item);
	}
}

export default class PdfCommenterPlugin extends Plugin {
	onload(): void {
		// Register the custom view
		this.registerView(
			VIEW_TYPE_PDF_COMMENTER,
			// NOTE: Obsidian's runtime manifest includes `dir` (folder name under .obsidian/plugins).
			// This can differ from `id` during development if the folder name doesn't match.
			(leaf) => new PdfCommenterView(leaf, { pluginId: this.manifest.id, pluginDir: (this.manifest as PluginManifest & { dir?: string }).dir ?? this.manifest.id })
		);

		// Claim .pdf extension from built-in viewer
		// @ts-expect-error viewRegistry is an undocumented internal API
		this.app.viewRegistry.unregisterExtensions(['pdf']);
		this.registerExtensions(['pdf'], VIEW_TYPE_PDF_COMMENTER);

		// Ribbon icon opens a fuzzy file picker filtered to PDFs
		this.addRibbonIcon("eye", "Open PDF", () => {
			new PdfFileSuggestModal(this.app).open();
		});

		// Command to open PDF picker
		this.addCommand({
			id: "open-pdf-viewer",
			name: "Open PDF",
			callback: () => {
				new PdfFileSuggestModal(this.app).open();
			}
		});
	}

	onunload(): void {
		// Restore built-in PDF viewer
		// @ts-expect-error viewRegistry is an undocumented internal API
		this.app.viewRegistry.unregisterExtensions(['pdf']);
		// @ts-expect-error viewRegistry is an undocumented internal API
		this.app.viewRegistry.registerExtensions(['pdf'], 'pdf');
	}
}
