/**
 * Action for the context menu
 */
export interface ContextMenuAction {
    id: string;
    label: string;
    icon?: string;
    callback: (selectedText: string) => void;
}

/**
 * Custom context menu for PDF viewer
 */
export class ContextMenu {
    private menuEl: HTMLElement | null = null;
    private actions: ContextMenuAction[];
    private currentText: string = '';

    constructor(actions: ContextMenuAction[]) {
        this.actions = actions;
        this.createMenu();
        
        // Hide menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.menuEl && !this.menuEl.contains(e.target as Node)) {
                this.hide();
            }
        });
        
        // Hide menu on scroll
        document.addEventListener('scroll', () => this.hide(), true);
        
        // Hide menu on escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hide();
        });
    }

    /**
     * Create the menu element
     */
    private createMenu(): void {
        this.menuEl = document.createElement('div');
        this.menuEl.className = 'pdf-context-menu';
        this.menuEl.style.display = 'none';
        
        // Add menu items
        for (const action of this.actions) {
            const item = document.createElement('div');
            item.className = 'pdf-context-menu-item';
            item.dataset.actionId = action.id;
            
            if (action.icon) {
                const icon = document.createElement('span');
                icon.className = 'pdf-context-menu-icon';
                icon.textContent = action.icon;
                item.appendChild(icon);
            }
            
            const label = document.createElement('span');
            label.className = 'pdf-context-menu-label';
            label.textContent = action.label;
            item.appendChild(label);
            
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                action.callback(this.currentText);
                this.hide();
            });
            
            this.menuEl.appendChild(item);
        }
        
        document.body.appendChild(this.menuEl);
    }

    /**
     * Show the context menu at the specified position
     */
    show(x: number, y: number, selectedText: string): void {
        if (!this.menuEl || !selectedText) return;
        
        this.currentText = selectedText;
        
        // Position the menu
        this.menuEl.style.left = `${x}px`;
        this.menuEl.style.top = `${y}px`;
        this.menuEl.style.display = 'block';
        
        // Adjust if menu goes off screen
        const rect = this.menuEl.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        if (rect.right > viewportWidth) {
            this.menuEl.style.left = `${viewportWidth - rect.width - 10}px`;
        }
        
        if (rect.bottom > viewportHeight) {
            this.menuEl.style.top = `${viewportHeight - rect.height - 10}px`;
        }
    }

    /**
     * Hide the context menu
     */
    hide(): void {
        if (this.menuEl) {
            this.menuEl.style.display = 'none';
        }
        this.currentText = '';
    }

    /**
     * Update the actions
     */
    setActions(actions: ContextMenuAction[]): void {
        this.actions = actions;
        if (this.menuEl) {
            this.menuEl.remove();
        }
        this.createMenu();
    }

    /**
     * Destroy the context menu
     */
    destroy(): void {
        if (this.menuEl) {
            this.menuEl.remove();
            this.menuEl = null;
        }
    }
}

