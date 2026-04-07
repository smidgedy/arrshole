export async function drain(response: Response): Promise<void> {
  await response.body?.cancel();
}
