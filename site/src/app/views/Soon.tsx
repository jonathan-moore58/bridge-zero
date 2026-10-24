// The screens still being moved from the prototype into the app.

const TITLES: Record<string, string> = {
  tx: "Transfer",
  receipt: "Receipt",
  activity: "Activity",
  network: "Network",
  lab: "Attack lab",
};

export function Soon({ name }: { name: string }) {
  return (
    <div class="page">
      <header class="page__head">
        <div>
          <h1 class="page__title">{TITLES[name] ?? name}</h1>
        </div>
      </header>
      <p class="sheet-lead">
        This screen moves from the prototype into the app next. <a href="#/bridge">Back to the bridge</a>
      </p>
    </div>
  );
}
