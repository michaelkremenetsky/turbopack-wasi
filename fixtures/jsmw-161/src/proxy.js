import { NextResponse } from "next/server";
export function proxy() { const r = NextResponse.next(); r.headers.set("X-Test", "1"); return r; }
export const config = { matcher: "/((?!api|_next/static|_next/image|favicon.ico).*)" };
