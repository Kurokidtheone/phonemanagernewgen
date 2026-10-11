// One short message at the bottom of the screen.
type Listener = (message: string) => void;
let listener: Listener | null = null;
export const onToast = (l: Listener | null): void => {
  listener = l;
};
export const toast = (message: string): void => listener?.(message);
