class Committee < ApplicationRecord
  has_many :contributions, dependent: :restrict_with_exception

  TYPES = %w[presidential senate house pac].freeze

  validates :fec_id, presence: true, uniqueness: true
  validates :name, presence: true
  validates :committee_type, inclusion: { in: TYPES }
end
