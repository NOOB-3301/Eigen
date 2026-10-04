import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/agents
 * List all discovered agents with their metadata
 */
export async function GET(req: NextRequest) {
  try {
    // Call engine API (running on port 4111) to get agents
    const res = await fetch('http://127.0.0.1:4111/api/agents', {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Engine unavailable' }, { status: 503 });
    }

    const agents = await res.json();
    return NextResponse.json(agents);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch agents', details: String(error) },
      { status: 500 }
    );
  }
}
