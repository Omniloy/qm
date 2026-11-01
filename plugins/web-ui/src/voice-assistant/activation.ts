export function onFirstActivation(run: () => void): void {
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (activation?.hasBeenActive) {
    run();
    return;
  }
  const once = () => {
    document.removeEventListener("click", once, true);
    document.removeEventListener("keydown", once, true);
    setTimeout(run);
  };
  document.addEventListener("click", once, true);
  document.addEventListener("keydown", once, true);
}
