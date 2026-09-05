import { createContext, useContext } from 'react';

export const ConfirmContext = createContext(null);

export function useConfirmContext() {
  return useContext(ConfirmContext);
}

export default ConfirmContext;
