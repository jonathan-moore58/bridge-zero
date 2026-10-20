import { ExtLink, Md, SectionHead } from "../components/ui.tsx";
import { records, REPO } from "../lib/chains.ts";
import type { Roadmap as RoadmapRecord } from "../lib/records-types.ts";

const RM = records.roadmap;

type Item = RoadmapRecord["groups"][number]["items"][number];

/**
 * An item of a later group. A bold lead followed by its own sentence ("**A web app.** Lock, mint…")
 * becomes the item's title; a lead that runs on into the sentence ("**Portaldot's V3 mainnet,**
 * once it is live") stays one sentence, as the README writes it.
 */
function LaterItem({ it }: { it: Item }) {
  const gate = /^Before any mainnet value/i.test(it.lead ?? "");
  const titled = !!it.lead && /[.!?]$/.test(it.lead) && !/^[a-z]/.test(it.text);
  return (
    <li class={`rm-item card spot ${gate ? "rm-item--gate" : ""}`}>
      {titled ? (
        <>
          <h4 class="rm-item__title">{(it.lead ?? "").replace(/[.!?]$/, "")}</h4>
          <p class="small muted">
            <Md text={it.text} base={REPO} />
          </p>
        </>
      ) : (
        <p class="small muted">
          {it.lead && <strong class="rm-item__lead">{it.lead} </strong>}
          <Md text={it.text} base={REPO} />
        </p>
      )}
    </li>
  );
}

export function Roadmap() {
  if (!RM) return null;
  // The README's first group is what comes next; every group after it is later, in its order.
  const [next, ...later] = RM.groups;
  return (
    <section id="roadmap" class="section section--alt" aria-labelledby="roadmap-title">
      <div class="container">
        <SectionHead
          id="roadmap"
          n="08"
          eyebrow="Roadmap"
          title={
            <>
              Where it goes from here. <em>Plans, not promises.</em>
            </>
          }
          lead={<Md text={RM.intro} base={REPO} />}
        />
        <div class="roadmap reveal">
          {next && (
            <div class="rm-next card">
              <header class="rm-head">
                <h3 class="rm-group rm-group--next">{next.title}</h3>
              </header>
              <ol class="rm-line">
                {next.items.map((it, i) => (
                  <li key={i}>
                    <span class="rm-line__node" aria-hidden="true" />
                    <p>
                      {it.lead && <strong>{it.lead} </strong>}
                      <Md text={it.text} base={REPO} />
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {later.length > 0 && (
            <div class="rm-later">
              {later.map((g) => (
                <div class="rm-after" key={g.title}>
                  <header class="rm-head">
                    <h3 class="rm-group">{g.title}</h3>
                  </header>
                  <ul class="rm-grid">
                    {g.items.map((it, i) => (
                      <LaterItem key={i} it={it} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
        <p class="small dim rm-foot">
          In the README's words, from its <ExtLink href={`${REPO}#roadmap`}>Roadmap</ExtLink> at this build.
        </p>
      </div>
    </section>
  );
}
