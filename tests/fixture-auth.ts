// Opt-in synthetic session for browser fixtures that do not exercise auth.
export function fixtureAuth(request: Request) {
  if (
    process.env.GROVE_TEST_AUTH_STUB &&
    new URL(request.url).pathname === "/api/auth/status"
  )
    return Response.json({
      state: "signed_in",
      user: { id: "fixture-user", name: "Fixture", color: "#555555" },
      colors: ["#555555"],
    });
}
