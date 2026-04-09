/** Consume and discard a response body to free the underlying socket. */
export async function drain(response: Response): Promise<void> {
  await response.arrayBuffer();
}
