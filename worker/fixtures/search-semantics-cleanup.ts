// Cleanup deployment only: remove all DO exports/bindings before the v2 deletion.
export default { fetch(): Response { return new Response("Not found", { status: 404 }); } };
