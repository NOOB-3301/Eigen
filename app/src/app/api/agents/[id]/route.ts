import { NextRequest, NextResponse } from 'next/server';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const res = await fetch(`http://127.0.0.1:4111/api/agents/${id}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to delete agent ${id}` },
        { status: res.status }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to delete agent', details: String(error) },
      { status: 500 }
    );
  }
}
