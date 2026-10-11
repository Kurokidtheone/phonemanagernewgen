import { useQuery } from '@tanstack/react-query';
import { loadPrinter } from './printer';

/** The saved printer, or null when none was chosen yet. */
export const usePrinterConfig = () => useQuery({ queryKey: ['printer'], queryFn: loadPrinter, staleTime: 0 });
