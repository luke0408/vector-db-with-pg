import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders title and search button', () => {
    render(<App />)

    expect(screen.getByText('NamuWiki Vector Search Practice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '검색' })).toBeInTheDocument()
  })
})
