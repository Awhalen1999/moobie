// PostHog on the built site only, so working on it locally sends nothing.
// Moobie shares the awln.dev project (one project is what the free plan
// allows), so every event is stamped app=moobie - dashboards filter on that.
// Page views, clicks, and sessions are captured by PostHog itself; `track`
// adds the moments it can't name on its own. The library is large, so it
// loads after the page rather than with it.

const posthog = import.meta.env.PROD
  ? import("posthog-js").then(({ default: posthog }) => {
      posthog.init("phc_YrGXbAy5VOj2nn5PNaPp1uC9s8I7JMVkefOizAsQht6", {
        api_host: "https://us.i.posthog.com",
        defaults: "2025-05-24",
        // Replays show the search boxes as typed - there's nothing private on the site.
        session_recording: { maskAllInputs: false },
      });
      posthog.register({ app: "moobie" }); // on every event from here on
      // Record regardless of any sampling or flag the shared project sets.
      posthog.startSessionRecording();
      return posthog;
    })
  : null;

/** Send a named event. A no-op locally. */
export function track(event: string, properties: Record<string, string | number | null>): void {
  posthog?.then((p) => p.capture(event, properties));
}

// Two moments every page has: the theme switch, and the card title that
// leads off to Letterboxd. The pages track their own card opens.
document.addEventListener("click", (e) => {
  const target = e.target as Element;
  if (target.closest(".theme")) {
    // The layout's handler runs first, so the attribute already holds the new theme.
    track("theme switched", { to: document.documentElement.dataset.theme ?? "" });
    return;
  }
  const title = target.closest<HTMLAnchorElement>(".panel h3 a");
  if (title) track("letterboxd opened", { film: title.textContent ?? "", url: title.href });
});
