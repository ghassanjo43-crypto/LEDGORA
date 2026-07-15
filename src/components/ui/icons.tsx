import {
  LayoutDashboard,
  ListTree,
  Building2,
  Map,
  ArrowLeftRight,
  Settings,
  Plus,
  Pencil,
  Trash2,
  Copy,
  ChevronRight,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Search,
  X,
  Check,
  Sun,
  Moon,
  Download,
  Upload,
  TriangleAlert,
  CircleAlert,
  RotateCcw,
  GripVertical,
  BookOpen,
  Ban,
  Send,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

/**
 * App icon set. Backed by lucide-react so the ENTIRE application shares one
 * icon language (the shell, dashboard and design-system components import
 * lucide directly; every legacy `Icon.*` call site resolves to the same set
 * through these thin wrappers).
 *
 * Defaults: 18px, 1.8 stroke — matching the app's line-icon weight. Callers
 * override freely with `className` (e.g. `h-4 w-4`) or lucide props.
 */
function make(C: LucideIcon) {
  const Wrapped = (props: LucideProps) => <C size={18} strokeWidth={2} {...props} />;
  Wrapped.displayName = `Icon(${C.displayName ?? 'lucide'})`;
  return Wrapped;
}

export const Icon = {
  Dashboard: make(LayoutDashboard),
  Tree: make(ListTree),
  Building: make(Building2),
  Map: make(Map),
  Transfer: make(ArrowLeftRight),
  Settings: make(Settings),
  Plus: make(Plus),
  Edit: make(Pencil),
  Trash: make(Trash2),
  Copy: make(Copy),
  Chevron: make(ChevronRight),
  ChevronDown: make(ChevronDown),
  ArrowUp: make(ArrowUp),
  ArrowDown: make(ArrowDown),
  Search: make(Search),
  Close: make(X),
  Check: make(Check),
  Sun: make(Sun),
  Moon: make(Moon),
  Download: make(Download),
  Upload: make(Upload),
  Alert: make(TriangleAlert),
  Warning: make(CircleAlert),
  Reset: make(RotateCcw),
  Grip: make(GripVertical),
  Book: make(BookOpen),
  Ban: make(Ban),
  Post: make(Send),
};
