import { NextRequest, NextResponse } from 'next/server';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json();

    const res = await fetch(`http://127.0.0.1:4111/api/agents/${id}/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to update agent ${id}` },
        { status: res.status }
      );
    }

    const updated = await res.json();
    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update agent config', details: String(error) },
      { status: 500 }
    );
  }
}
